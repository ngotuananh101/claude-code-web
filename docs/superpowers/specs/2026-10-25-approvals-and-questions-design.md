# Design — Approvals & user questions (ARCHITECTURE §13)

- Date: 2026-10-25
- Owner request: "Có nguồn tham khảo rồi thì làm đi… làm theo đúng quy trình"
  — implement §13 after studying jetbrains-cc-gui's SDK response/permission
  handling. Owner-approved decisions (2026-10-25): **both kinds in MVP**
  (tool_permission + user_question), **card inline in EventJournal**,
  **default expiry 5 minutes**.

## Intent

Today a run executes end-to-end with whatever the SDK `permissionMode`
allows (`bypassPermissions` today). §13 adds the human gate mid-run: the
SDK's `canUseTool` callback suspends the run, the request travels
runner → server → browser, the owner decides, the decision travels back
and resolves exactly the callback that asked. Same pipeline answers
`AskUserQuestion`.

## Goals / non-goals / anti-goals

- **Goals (MVP §13.2):** approve once / reject; answer a question;
  exact-identity validation on the runner; exactly-once callback
  resolution; timeout → deny (never implicit approve); worker-crash
  abandon via the existing reconcile path.
- **Non-goals:** persisted always-allow rules; permission-rules editing
  UI; approval for runs on other runners' sessions; mobile.
- **Anti-goals:** timeout/cancel silently approving; an old decision
  applied to a new callback after resume; tool input payloads reaching
  server *logs* (§19.4 — the journal card is the product surface, logs
  are not).

## What already exists (verified 2026-10-25)

- Protocol: event types `approval.requested/resolved/expired`,
  `question.requested/answered`; command kind `approval.respond`; run
  state `waiting_for_approval`; reconcile action `abandon_approval`
  (fires when server thinks a run is waiting but `approvalsAlive` is
  false).
- `packages/runner-db`: `pending_approvals` table (approval_id PK,
  attempt_id, tool_call_id, input_hash, callback_generation, kind,
  expires_at, state, created_at).
- `packages/control-db`: `command_outbox` accepts kind `approval.respond`.
- Runner: real SDK adapter `@cc-web/agent-adapter` behind the
  `SdkStream` seam in `execution/executor.ts`; `RunController` routes
  `run.cancel` before the run-start path (the pattern `approval.respond`
  will copy); redaction exists (`redact.ts`).
- Reference semantics adopted from jetbrains-cc-gui: strict allow parse
  (only an explicit `true`/`allow` counts), timeout → deny with a
  message, permission logs carry metadata only, never payloads. Its
  file-based IPC is *not* adopted — we have the durable WS + outbox.

## Architecture

### 1. Runner — the permission gate

- `SdkOptions` gains `canUseTool`; `@cc-web/agent-adapter` forwards it
  into `query()`.
- `executeRun` builds a per-attempt **gate** and registers it on an
  **ApprovalRouter** owned by `RunController` (same lifetime as the
  in-flight map; single-threaded event loop makes the live map the CAS
  point, backed by a `state='pending'` compare in SQL).
- `canUseTool(toolName, input, options)`:
  1. Mint `toolCallId` (`tc_<uuid>`) — the SDK gives no usable id; the
     identity is ours.
  2. `inputHash = SHA-256(canonical JSON {toolName, input})`.
  3. Persist `pending_approvals` row; append `approval.requested` with
     `{approvalId, runId, attemptId, toolCallId, inputHash,
     callbackGeneration, kind, toolName, expiresAt}` plus, by kind:
     `tool_permission` → `inputSummary` (redacted, truncated ≤2KB tool
     input for the decision card); `user_question` → a structured
     `questions` array (the AskUserQuestion input passed through the
     redactor, ≤4 questions as the SDK caps, option text truncated
     500 chars each) — structured data, not the summary blob, is what
     the card renders as option buttons. `expiresAt` is minted by the
     runner (authoritative; server treats it as display data):
     `now + CC_WEB_APPROVAL_TIMEOUT_MS` when that variable is a positive
     number, else `Number.MAX_SAFE_INTEGER` — a gate does not expire by
     default and waits for a human until decided or the run is torn down.
     `callbackGeneration` is 0 within an attempt (§9.7: an attempt is
     single-stream, stale attempts are interrupted, never resumed); the
     field is carried for exactness per §13.1.
  4. Await: race(resolution promise, expiry timer, run abort signal).
     Timeout → deny "approval timed out"; abort → deny "run cancelled".
- `kind`: `tool_permission` normally; `user_question` when toolName is
  `AskUserQuestion`. Resolution returns
  `{behavior:"allow", updatedInput:{questions, answers}}` for an allowed
  question, `{behavior:"deny", message}` otherwise — matching the SDK
  contract.
- Resolution path: `RunController.handle` routes kind `approval.respond`
  before the run-start path (like `run.cancel`). Validation, all required
  to resolve: approval id exists, attempt matches the envelope's run,
  row state `pending`, `inputHash` matches the hash the server echoes
  back, not past `expiresAt`, live callback present. Any failure → no
  resolution, outcome emitted, receipt stays accepted (the inbox dedup
  owns replay). Success → resolve exactly once, append
  `approval.resolved {approvalId, decision, source}`.
- Terminal vocabulary (builder-check settled): `approval.resolved` is
  reserved for a real user decision (`source: "user"`). Every non-user
  terminal is `approval.expired {approvalId, reason}` with reason
  `timeout | cancelled | aborted | abandoned | crashed` — cancel,
  shutdown drain, reconcile abandon, and boot recovery all deny their
  callbacks ("run cancelled"/"run interrupted") and emit `expired`, so
  projections and cards never wait on a decision that will not come.
  Boot recovery sweeps `pending_approvals` rows whose attempt
  `recoverStaleAttempts` already killed (marks expired, emits the event).
- Expiry sweep: injected-clock sweep (interval, plus a check on every
  route/handle) marks past-due rows expired → `approval.expired` +
  deny callback.
- Run state: `RunController` tracks `waiting_for_approval` per in-flight
  attempt (gate register/unregister drives it); daemon inventory reports
  it, so the server's existing `waiting_for_approval` +
  `approvalsAlive:false → abandon_approval` reconcile works unchanged.
  Abandon ⇒ pending rows abandoned, callbacks denied "run interrupted",
  old decisions never applied to new callbacks (§13.2).

### 2. Control-server — decision route and projection

- `packages/control-db`: tables `approvals` (projection from ingest:
  approval_id PK, session_id, run_id, runner_id, kind, tool_name,
  input_hash, input_summary, expires_at, state, created_at) and
  `approval_decisions` (approval_id FK, decision, answers_json,
  decided_at, delivered_at).
- Event ingest: `approval.requested` upserts the projection;
  `approval.resolved/expired` close it (compare-and-set, terminal
  idempotent — §18: transition CAS).
- New `POST /api/approvals/:id/decision` body
  `{decision: "allow"|"deny", answers?}`: JWT owner of the session only;
  one transaction = insert decision row + CAS the projection to decided
  + insert `command_outbox` row (`approval.respond` carrying
  `{approvalId, decision, answers, inputHash}`); the existing live
  dispatcher pumps it to the runner. Unknown/expired approval → 404/409;
  double decide → idempotent 409 with the recorded decision.
- Server logs never carry `input_summary` (§19.4).

### 3. Web — inline decision cards in EventJournal

- Pinia `approvals` store fed by the live journal stream, keyed by
  `approvalId`.
- `approval.requested` renders an interactive card in the journal at its
  event position: kind `tool_permission` → tool name + `inputSummary`
  + Approve/Reject; kind `user_question` → the structured `questions`
  array rendered as option buttons/inputs, submit answers.
- After POST: optimistic "đang chuyển quyết định" (§13.2 — not "tool đã
  chạy"); the terminal event flips the card: `approval.resolved` →
  đã cho phép / đã từ chối (by decision), `approval.expired` →
  đã hết hạn (reason `timeout`) / đã hủy (reason
  `cancelled|aborted|abandoned|crashed`). Double-submit guarded
  client-side; late card for a decided id renders read-only.
- Vietnamese copy per the operator-UI rule; domain nouns (tool, run,
  approval) stay English.

## Permission mode plumbing (builder-check Q1, folded in)

A gate only exists if the SDK calls `canUseTool`; today nothing sets
`permissionMode`, so the effective mode is the runner host's inherited
Claude settings — potentially `bypassPermissions`, under which the gate
never fires and this feature ships dormant. The project's standing next
task already decides the direction ("grow the run API so the composer's
runner/branch/model/permission selects stop being advisory"); the
**permissionMode slice ships with this work**: the composer's existing
permission select value rides the dispatch body → `run.start` payload →
`SdkOptions.permissionMode` → adapter. Absent value = `"default"`, so
app-issued runs gate by default and the owner's host config cannot
silently bypass the UI. This is the first slice of that agreed task;
runner/branch/model stay advisory. The UI keeps §13.2's honesty: a
permissive mode means not every tool prompts.

## Constraints

- TDD per repo convention (RED → verify fail → GREEN); no generated-file
  edits; Tailwind utilities only; §19.4 verbatim (no payload logging,
  redact before anything leaves the runner).
- The SDK seam stays an import boundary: tests drive the gate with fake
  callbacks, never the real SDK.
- bun test cannot compile .vue SFCs — web behavior is verified by
  typecheck/build + browser pass.

## Left to the builder (plan)

Exact DDL, function signatures, test matrices per slice, route wiring,
and the ingest projection's interaction with `journal.ts` — the plan doc
decides these; nothing here needs another owner decision.
