# Approvals & user questions (§13) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the SDK `canUseTool` so tool permissions and `AskUserQuestion` suspend a run, travel runner → server → browser, get a decision, and resolve exactly the callback that asked.

**Architecture:** A per-attempt gate in the runner's executor persists `pending_approvals`, emits `approval.requested` through the existing event outbox, and parks the SDK callback on a promise the `ApprovalRouter` resolves when the `approval.respond` command arrives (raced against expiry and abort). The server ingests the event into an `approvals` projection, serves `POST /api/approvals/:id/decision` (decision + outbox insert in one transaction), and the dispatcher pumps the command to the runner. The web renders interactive cards inline in EventJournal.

**Tech Stack:** Bun + TypeScript, bun:sqlite, `@cc-web/protocol` WS frames, Vue 3 + Tailwind utilities (no scoped CSS).

**Spec:** `docs/superpowers/specs/2026-10-25-approvals-and-questions-design.md` (decisions: both kinds; inline cards; 5-minute expiry; permissionMode rides the run payload, absent → `"default"`).

## Global Constraints

- TDD everywhere: RED (verify fail) → implement → GREEN → commit. Tests via `bun test <path>`.
- Never edit generated files (`apps/web/src/components/ui/**`, `styles/index.css`, `lib/utils.ts`, `components.json`).
- §19.4: server **logs** never carry tool inputs (the journal is the product surface, logs are not); redact before anything leaves the runner (`redact.ts`); errors one non-committal shape.
- Tailwind utilities only, Vietnamese operator copy, domain nouns (tool/run/approval) stay English.
- No version pinning; `bun.lock` is truth.
- bun test cannot compile .vue SFCs — web verification = typecheck + build + browser pass.
- Commit messages in repo style (`feat:`/`fix:` lowercase imperative); push to `main` is pre-authorized.

## Review Focus

1. **A corrupted/malicious decision payload must never resolve a callback** — strict parse: only `decision === "allow"` counts as allow; anything else denies. Test: T3.
2. **Old decisions never apply to new callbacks** — respond names a live `approvalId` + `inputHash` that must match the runner's row; a resolved/expired row refuses. Tests: T3 (stale hash, double respond), T2 (CAS once).
3. **A pending approval must never sit unseen** — the gate flushes the pump after every `approval.*` append (a suspended run never settles, so `onSettled` alone would strand the event until timeout). Test: T4 (flush hook called).
4. **Timeout/cancel/abandon must never approve** — every non-user terminal denies the callback and emits `approval.expired {reason}`. Tests: T3 (timeout sweep, abort, abandon).
5. **A decision accepted by the server but lost before the runner leaves the card stuck** — decision + `approval.respond` outbox row commit in ONE transaction; the card's optimistic state is "đang chuyển quyết định", terminal only on the journal event. Test: T1 (transaction atomicity), T6 (card states).

---

### Task 1: control-db — approvals projection + decision transaction

**Files:**
- Modify: `packages/control-db/src/db.ts` (migrate: add `approvals`, `approval_decisions`)
- Create: `packages/control-db/src/approvals.ts`
- Modify: `packages/control-db/src/index.ts` (exports), `packages/control-db/src/command-outbox.ts` (export `fingerprintOf`, add sync insert)
- Test: `packages/control-db/src/approvals.test.ts`

**Interfaces:**
- Produces:
  - `upsertApprovalRequested(db, input: {approvalId, sessionId, runId, runnerId, kind, toolName, inputHash, inputSummary, expiresAt, now?}): void` — `INSERT OR IGNORE` (replay-idempotent).
  - `closeApproval(db, input: {approvalId, state: "resolved"|"expired", now?}): boolean` — CAS `pending|decided → state`, false when absent/already terminal.
  - `recordApprovalDecision(db, input: {approvalId, decision: "allow"|"deny", answersJson?: string, outbox: {commandId, fingerprint}, now?}): {ok: true; runnerId; inputHash; sessionId} | {ok: false; reason: "unknown"|"not_pending"}` — ONE transaction: CAS `pending → decided`, INSERT `approval_decisions`, sync-insert the `approval.respond` command row into `command_outbox`.
  - `approvalForSession(db, approvalId): {sessionId, runnerId, state, inputHash, kind, toolName, inputSummary, expiresAt} | undefined`.
  - `CommandOutbox.insertPendingSync(input: EnqueueInput, fingerprint: string): void` — the same SQL as `enqueue` minus the async fingerprint, callable inside a caller's transaction.

- [ ] **Step 1: Failing tests** — schema creates both tables on migrate; `upsertApprovalRequested` twice = one row; `recordApprovalDecision` on unknown id → `unknown`, on fresh id → `ok` + row state `decided` + decision row present + `command_outbox` row of kind `approval.respond` with the exact payload `{approvalId, decision, answers, inputHash}`; second decision → `not_pending`; `closeApproval` CAS once.
- [ ] **Step 2: Run `bun test packages/control-db/src/approvals.test.ts`** — expect FAIL (module missing).
- [ ] **Step 3: Implement** — DDL per spec (`approvals`: approval_id PK, session_id, run_id, runner_id, kind, tool_name, input_hash, input_summary, expires_at INTEGER, state, created_at; `approval_decisions`: approval_id, decision, answers_json, decided_at). Sync insert duplicates `enqueue`'s SQL with the caller-supplied fingerprint.
- [ ] **Step 4: Run** — expect PASS; then `bun test packages/control-db` all green.
- [ ] **Step 5: Commit** — `feat: add the approvals projection and decision transaction`

### Task 2: runner-db — pending approval CAS helpers

**Files:**
- Create: `packages/runner-db/src/approvals.ts`
- Modify: `packages/runner-db/src/index.ts` (exports)
- Test: `packages/runner-db/src/approvals.test.ts`

**Interfaces:**
- Produces:
  - `insertPendingApproval(db, input: {approvalId, attemptId, toolCallId, inputHash, callbackGeneration, kind, expiresAt, now?}): {ok: true} | {ok: false; reason: "duplicate"}` (table already exists in `db.ts`).
  - `pendingApproval(db, approvalId): {approvalId, attemptId, toolCallId, inputHash, callbackGeneration, kind, expiresAt, state} | undefined`.
  - `finishApproval(db, input: {approvalId, state: "resolved"|"expired", now?}): boolean` — CAS `state='pending'` → target; false otherwise.
- Consumes: existing `pending_approvals` DDL.

- [ ] **Step 1: Failing tests** — roundtrip; duplicate insert → `duplicate`; `finishApproval` true once then false; `pendingApproval` of unknown → undefined; state column never leaves {pending, resolved, expired}.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** — three functions, CAS via `UPDATE … WHERE approval_id=? AND state='pending'` checking `changes`.
- [ ] **Step 4: Run** — PASS + `bun test packages/runner-db` green.
- [ ] **Step 5: Commit** — `feat: add pending approval persistence helpers`

### Task 3: runner — ApprovalRouter and the SDK gate

**Files:**
- Create: `apps/runner/src/execution/approvals.ts`
- Modify: `apps/runner/src/execution/redact.ts` (add `summarizeToolInput(input: unknown): string` — JSON stringify → `redactErrorText` → truncate 2000 chars)
- Test: `apps/runner/src/execution/approvals.test.ts`

**Interfaces:**
- Consumes: Task 2 helpers; `redact.ts`.
- Produces:
  - `canonicalInputHash(toolName: string, input: unknown): string` — SHA-256 over recursive key-sorted JSON of `{toolName, input}` (`Bun.CryptoHasher("sha256")`).
  - `type ApprovalOutcome = {behavior: "allow"; updatedInput?: unknown} | {behavior: "deny"; message: string}`.
  - `class ApprovalRouter` with options `{db, append: (type: string, payload: unknown) => void, now?: () => number, schedule?: (fn: () => void, ms: number) => (() => void)}`:
    - `open(input: {attemptId, runId, kind: "tool_permission"|"user_question", toolName, input, timeoutMs}): Promise<ApprovalOutcome>` — mints `approvalId` (`apr_<uuid>`) and `toolCallId` (`tc_<uuid>`), persists via Task 2, appends `approval.requested {approvalId, runId, attemptId, toolCallId, inputHash, callbackGeneration: 0, kind, toolName, expiresAt, ...(kind === "user_question" ? {questions} : {inputSummary})}` (`questions` = redacted structured array, option text truncated 500; `inputSummary` = `summarizeToolInput`), schedules its own timeout.
    - `respond(payload: {approvalId, decision, answers?, inputHash}, context: {attemptId, runId}, now?): {ok: true} | {ok: false; reason: "unknown"|"attempt_mismatch"|"hash_mismatch"|"expired"|"already_finished"}` — strict parse: `decision === "allow"` or it is a deny; validates Task-2 row state `pending` + hash + expiry + live callback; resolves the parked promise: allow + `user_question` → `{behavior:"allow", updatedInput:{questions, answers}}`; allow → `{behavior:"allow", updatedInput: <original input>}`; deny → `{behavior:"deny", message:"User denied permission for <tool>"}` (question: `"User did not answer the question"`); appends `approval.resolved {approvalId, decision, source: "user"}`.
    - `sweepExpired(now?): void` — every pending row past expiry: `finishApproval(expired)`, deny "approval timed out", append `approval.expired {approvalId, reason: "timeout"}`.
    - `abandonAttempt(attemptId, reason: "cancelled"|"aborted"|"abandoned"|"crashed"): void` — all live callbacks for the attempt denied ("run cancelled"/"run interrupted") + rows finished expired + `approval.expired {reason}` appended.
- [ ] **Step 1: Failing tests** — (a) requested event carries every identity field and hashes deterministically; (b) allow path resolves with allow and emits `approval.resolved`; (c) `decision: "true"`/missing field denies (strict parse); (d) respond with wrong `inputHash` / wrong attempt / twice / unknown → refuses, callback stays parked; (e) timeout (fake `now` + manual sweep) denies + emits expired; (f) abandonAttempt denies + emits expired; (g) `user_question` allow resolves `updatedInput` with answers merged.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** — live callbacks in a `Map<approvalId, {resolve, attemptId, timer}>`; `respond` runs validation then a single `finishApproval` CAS as the once-guard.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat: add the runner approval gate and router`

### Task 4: runner — executor/controller/daemon wiring

**Files:**
- Modify: `apps/runner/src/execution/executor.ts` (`SdkOptions` + `ExecuteOptions` + gate lifecycle)
- Modify: `apps/runner/src/execution/run-controller.ts` (`approval.respond` routing, waiting tracking, `inventory()`)
- Modify: `packages/agent-adapter/src/index.ts` (`SdkStreamInput.permissionMode`, `canUseTool` passthrough into `options`)
- Modify: `apps/runner/src/daemon.ts` (wire `inventory: () => runs.inventory()`, `onApprovalEvent → pump.flush()`)
- Test: `apps/runner/src/execution/executor.test.ts` (extend), `apps/runner/src/execution/run-controller.test.ts` (extend), `apps/runner/src/daemon.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3 (`ApprovalRouter`, `canonicalInputHash`), existing `SdkStream` seam.
- Produces:
  - `SdkOptions` gains `permissionMode: string; canUseTool?: (toolName: string, input: unknown, options: {signal: AbortSignal}) => Promise<ApprovalOutcome>`.
  - `ExecuteOptions` gains `router: ApprovalRouter; onApprovalEvent?: () => void; permissionMode?: string`.
  - Executor behavior: gate = a `canUseTool` closing over `router.open({attemptId, runId, …})` + `append` + `onApprovalEvent`; `record.permissionMode ?? "default"` forwarded; every `approval.*` append triggers `onApprovalEvent`; on abort/terminal/finally → `router.abandonAttempt(attemptId, reason)`.
  - `RunController.handle`: `kind === "approval.respond"` routes before run-start (like `run.cancel`) → `router.respond(payload, {attemptId: parsed.attemptId ?? "", runId: parsed.runId ?? ""})`; receipt `accepted: true` either way, `reason` included on refusal.
  - `RunController.inventory(): RunnerInventoryItem[]` — in-flight runs map to `{runId, attemptId, state: waiting ? "waiting_for_approval" : "running", processAlive: true, approvalsAlive: <live callbacks exist>}`; waiting flips via router callbacks (`onWaitingChange(attemptId, waiting)`).

- [ ] **Step 1: Failing tests** — (a) executor with a fake SDK stream that calls `canUseTool("Bash", …)` emits `approval.requested` with correct attempt identity and the flush hook fires; (b) resolving via `controller.handle(approval.respond)` unblocks the stream and the run finishes; (c) `permissionMode` lands in the adapter's `options` (absent payload → `"default"`); (d) abort while parked → `run.interrupted` + `approval.expired` reason `aborted`; (e) `inventory()` reports `waiting_for_approval` while parked, `running` after; (f) `approval.respond` for an unknown id returns accepted receipt with `reason` and resolves nothing; (g) boot sweep: pending rows whose attempt `recoverStaleAttempts` killed are finished `expired` in place, WITHOUT a fabricated event (the dead attempt's event stream is complete — §18.3 sequence continuity — and reconcile already marks those runs interrupted server-side).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** — adapter: `if (input.permissionMode !== undefined) options["permissionMode"] = input.permissionMode; if (input.canUseTool !== undefined) options["canUseTool"] = input.canUseTool;` Executor owns the router for its attempt (created per run from `ExecuteOptions.router` factory or shared router keyed by attempt — shared `ApprovalRouter` on the controller, keyed lookups by attempt). Boot sweep = SQL-only pass in the controller constructor after `recoverStaleAttempts` (per-approval timers already cover timeout; no interval needed in prod).
- [ ] **Step 4: Run** — PASS + `bun test apps/runner packages/agent-adapter` green.
- [ ] **Step 5: Commit** — `feat: suspend runs on approval requests and resolve them from commands`

### Task 5: protocol + server — registry transitions, ingest projection, decision route

**Files:**
- Modify: `packages/protocol/src/run-registry.ts` (add `markWaitingForApproval(runId, attemptId)` / `markApprovalResolved(runId, attemptId)`)
- Create: `apps/control-server/src/approvals/ingest.ts` (post-ingest hook: `approval.requested` → `upsertApprovalRequested` + `markWaitingForApproval`; `approval.resolved`/`expired` → `closeApproval` + `markApprovalResolved`)
- Create: `apps/control-server/src/routes/approvals-routes.ts`
- Modify: `apps/control-server/src/server.ts` (call ingest hook in the `onEvents` loop after `ingestEvent`; mount the route)
- Test: `packages/protocol/src/run-registry.test.ts` (extend), `apps/control-server/src/approvals/ingest.test.ts`, `apps/control-server/src/routes/approvals-routes.test.ts`

**Interfaces:**
- Consumes: Task 1 (`upsertApprovalRequested`, `closeApproval`, `recordApprovalDecision`, `approvalForSession`, `fingerprintOf`).
- Produces:
  - `RunRegistry.markWaitingForApproval(runId, attemptId): void` — current attempt only; observed `starting|running → waiting_for_approval`; terminal/unknown ignored. `markApprovalResolved` → `waiting_for_approval → running`.
  - `handleApprovalDecision(request, options, allowedOrigins, browserGateway, dispatcher, approvalId): Promise<Response>` — origin + `browserGateway.authorize` (JWT) as in `runs-routes.ts`; body `{decision: "allow"|"deny", answers?}` (400 otherwise); command id minted + `fingerprintOf` computed BEFORE the transaction; `recordApprovalDecision` does the atomic write (the `outbox` param would be redundant — its dispatcher already owns the outbox); on `ok` → `dispatcher.drain(runnerId)` → 202 `{approvalId, state: "decided"}`; `unknown` → 404; `not_pending` → 409 (idempotent: same decision returns the recorded one).

- [ ] **Step 1: Failing tests** — registry transitions + ignore rules (wrong attempt, terminal); ingest hook projects a stored `approval.requested` into `approvals` + registry waiting, and closes on terminal events; route: 401 unauthenticated, 400 bad body, 404 unknown approval, 202 happy path enqueues `approval.respond` for the right runner and drains, 409 double decision.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** — route copies the `runs-routes` authorize pattern; note: the server has no sessions table, so ownership = valid JWT (single-owner MVP, §19.2 scope).
- [ ] **Step 4: Run** — PASS + `bun test packages/protocol apps/control-server` green.
- [ ] **Step 5: Commit** — `feat: serve approval decisions and project them onto the run registry`

### Task 6: web — decision cards, approvals API, permissionMode plumbing

**Files:**
- Create: `apps/web/src/features/approvals/store.ts` (module-level reactive map keyed by approvalId: `{deciding, decision?}`, `submitDecision(approvalId, decision, answers?)`)
- Create: `apps/web/src/services/approvals-api.ts` (POST `/api/approvals/${id}/decision`; maps 202/401/404/409; VN toasts)
- Create: `apps/web/src/components/ApprovalCard.vue`
- Modify: `apps/web/src/components/EventJournal.vue` (render `ApprovalCard` for `approval.requested` rows instead of the raw JSON pre; terminal state derived from later events with the same `payload.approvalId`)
- Modify: `apps/web/src/services/runs-api.ts` + `apps/web/src/components/Composer.vue` (send `permissionMode` from the existing select in the dispatch body)
- Modify: `apps/control-server/src/routes/runs-routes.ts` + `packages/control-db/src/scheduler.ts` (validate `permissionMode ∈ {default, acceptEdits, bypassPermissions, plan}` → include in `scheduler.dispatch` input → `run.start` payload)
- Test: `apps/web/src/services/approvals-api.test.ts`, `apps/control-server/src/routes/runs-routes.test.ts` (extend)

**Interfaces:**
- Consumes: Task 5's route.
- Produces: cards inline in the journal; `POST /api/sessions/:id/runs` body gains optional `permissionMode`.

- [ ] **Step 1: Failing tests** — API maps statuses (`202 → ok`, `409 → conflict toast`, `401 → re-auth`); runs-routes accepts/forwards `permissionMode`, rejects unknown values with 400; composer body test in `runs-api.test.ts`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** — `ApprovalCard`: kind `tool_permission` → mono tool name + `inputSummary` pre + Approve/Reject `Button` (sm); kind `user_question` → v-for `questions` with option `Button`s + free-text Input for "Other", submit; optimistic "Đang chuyển quyết định…" after POST; terminal from journal (`approval.resolved` → "Đã cho phép"/"Đã từ chối", `approval.expired` → reason `timeout` ? "Đã hết hạn" : "Đã hủy"); display-side fallback: `expiresAt` in the past with no terminal event renders "Đã hết hạn" (covers a boot-swept row whose event never shipped); decided id re-renders read-only. Tailwind utilities, no scoped CSS.
- [ ] **Step 4: Run** — API + route tests PASS; then `bun run typecheck`, `cd apps/web && bun run build`.
- [ ] **Step 5: Commit** — `feat: decide approvals and questions from the session journal`

### Task 7: E2E demo pass + gates + ship

**Files:**
- Modify (local only, NOT committed): `/tmp/cc-web-fake-runner.ts` — on prompt keyword `approve`, emit a hand-built `approval.requested` event (full identity), wait for the `approval.respond` command, then emit `approval.resolved` and finish the run.
- Docs: append ledger entry (`.superpowers/…/progress.md`, local only); update memory handoff.

- [ ] **Step 1: `bun test`** (full suite) + `bun run typecheck` + `bun run lint` + `cd apps/web && bun run build` — all green.
- [ ] **Step 2: Browser pass** against the live demo (vite :5173, control server :8787, fake runner): send prompt with `approve` → card appears inline; Approve → "Đang chuyển quyết định…" → "Đã cho phép"; second run → Reject path; third → let it time out (or verify reason label); permission select `bypassPermissions` shows the amber warning and still round-trips.
- [ ] **Step 3: Commit** any remaining changes — `feat: end-to-end approvals` (if anything tracked changed) — and push to `main`.
- [ ] **Step 4: Ledger + memory** update; Vietnamese report.
