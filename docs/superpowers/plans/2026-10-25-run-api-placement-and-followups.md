# Run API: real placement + model, ledger follow-ups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the composer's workspace/runner/model selects real end-to-end (§5.2, §6.4, §11.3, §16.1) and clear the six deferred review findings (F2–F7) from the approvals ledger.

**Architecture:** Runners declare their workspaces in the hello/reconcile handshake (§6.4 capabilities — the runner is the registration authority per §5.1); the control plane stores them declaratively per runner; `GET /api/workspaces` serves them; dispatch pins the runner through the chosen workspace instead of "first ready" (§11.3). The model choice rides the run.start payload exactly like `permissionMode` already does. Ledger follow-ups are small TDD tasks that land first so the new surface starts from a clean ledger.

**Tech Stack:** Bun + TypeScript, bun:sqlite, Vue 3 + reka-ui Select, bun test, biome.

**Spec:** `docs/ARCHITECTURE.md` §5.2 (workspace mapping), §6.2/§6.4 (handshake capabilities), §11.3 (scheduling MVP), §15.1 (workspace registration), §16.1 (workspace-first UX), §17.1 (GET /api/workspaces); follow-up provenance in `.superpowers/sdd/2026-10-25-approvals-and-questions/progress.md` (local only, never committed).

## Global Constraints

- TDD RED → verify fail → GREEN → commit, one commit per task, straight to `main` (standing authorization).
- Never edit generated shadcn-vue files (`apps/web/src/components/ui/**`, `apps/web/src/lib/utils.ts`, `apps/web/src/styles/index.css`, `apps/web/components.json`); biome protection override stays LAST.
- No version pinning — caret ranges, `bun.lock` is truth.
- §19.4 for every new route: Origin allowlist → authorize → validate; `Cache-Control: no-store` on responses; never log credentials or command payloads; identical refusal text style as existing routes (bare text, lowercase).
- UI copy is Vietnamese; domain nouns (runner, workspace, model, run) stay English; code comments/tests in English.
- Tailwind utilities only, no scoped CSS. `exactOptionalPropertyTypes: true` — conditional spread, never `undefined` for optional props.
- `bun:sqlite` `.get()` returns `null`, not `undefined`; `.query(sql).get(param)` binds, `.query(sql, param)` does not.
- bun test cannot compile .vue SFCs — web component work verifies via `bun run typecheck` + `cd apps/web && bun run build` (always inside apps/web; `bun --cwd` resolves vacuously).
- The `branch` select stays local/advisory this milestone (explicit non-goal: per-run branch has no §17.1 API until the §15 Git/file milestone).
- Do not commit `design.md`, `docs/ZCode-3.16.3-linux-x64.rpm`, `.superpowers/`, or `/tmp` demo files.

## Review Focus

1. **A workspaceId no runner declared must never dispatch to "any ready runner"** — the route answers 400 `unknown_workspace`. Test: Task 12 (unknown workspace refused, inbox empty).
2. **A runnerId that is not the owner's or is revoked must never receive a run** — ownership + revocation checked before pinning, same 400/503 vocabulary. Test: Task 12 (foreign runner refused).
3. **A `model` outside the offered set must be refused, not coerced** — mirrors the §13 permissionMode strictness; a typo must never silently run at the SDK default. Test: Task 11 (route 400, empty outbox).
4. **A runner restart declaring fewer workspaces must not leave stale registrations** — sync is declarative replace-per-runner; placement can never pick a workspace the current boot no longer declares. Test: Task 9 (replace semantics).
5. **An `approval.respond` for an attempt with no live router must be refused, never silently resolved** — no mute-router path that flips a row without emitting `approval.resolved`. Test: Task 5.

---

### Task 1: Strict-parse approval terminal mapping (F4)

**Files:**
- Create: `apps/web/src/features/approvals/terminal.ts`
- Modify: `apps/web/src/components/EventJournal.vue` (the `approvalTerminals` computed + `terminalFor`)
- Test: `apps/web/src/features/approvals/terminal.test.ts`

**Interfaces:**
- Consumes: journal rows shaped `{ event: { type: string; payload: unknown } }` (same shape EventJournal holds).
- Produces: `mapApprovalTerminals(rows: Array<{ type: string; payload: unknown }>): Map<string, { decision?: "allow" | "deny"; reason?: string }>` — keyed by `payload.approvalId`; `approval.resolved` contributes `decision` only when the exact string `"allow"`/`"deny"` (anything else contributes nothing — the runner only emits those two, so a garbled payload must not display as allowed); `approval.expired` contributes `reason` only when a non-empty string. Exported for EventJournal and reuse.

- [ ] **Step 1: Write the failing tests** — allow → `{decision:"allow"}`; deny → `{decision:"deny"}`; resolved payload with `decision:"true"` contributes NOTHING for that id; expired with `reason:"timeout"` → `{reason:"timeout"}`; expired with missing/garbled reason → `{}`; unknown event types ignored; later events for the same id overwrite earlier ones.
- [ ] **Step 2: Run** `bun test apps/web/src/features/approvals/terminal.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the pure function; replace the inline map in `EventJournal.vue`'s `approvalTerminals` with `mapApprovalTerminals(props.events.map((row) => row.event))` and `terminalFor` with a lookup on it. No behavior change beyond the strict parse.
- [ ] **Step 4: Run** `bun test apps/web/src/features/approvals` — PASS; then `bun run typecheck`.
- [ ] **Step 5: Commit** `git commit -m "fix: parse approval terminal events strictly for display"`

### Task 2: Card answer state keyed per question index (F5a)

**Files:**
- Modify: `apps/web/src/components/ApprovalCard.vue` (the `answers`/`others` records, `pick`, `answerWithOther`, `submitAnswers`, the option-button/`:class` and Input bindings)

**Interfaces:**
- Consumes: `questions` computed (array of `{question, header?, options}`), unchanged.
- Produces: outgoing `answers` payload in `submitDecision(approvalId, "allow", answersMap)` stays keyed by **question text** (that is the contract the runner/SDK consumes). Only the local reactive state switches to index keys: `answers: Record<number, string>`, `others: Record<number, string>`; `submitAnswers` builds `{ [q.question]: answers[index] }` skipping empty values. Two questions with identical text get independent UI slots.

- [ ] **Step 1: Rework the four functions + template bindings** to index keys; keep the selected-class comparison `answers[index] === option.label`.
- [ ] **Step 2: Verify** `bun run typecheck` and `cd apps/web && bun run build` — clean (SFC, no unit tests possible).
- [ ] **Step 3: Commit** `git commit -m "fix: key approval card answer state by question index"`

### Task 3: Approvals store unit tests (F6)

**Files:**
- Test: `apps/web/src/features/approvals/store.test.ts`

**Interfaces:**
- Consumes: `approvalUi(approvalId)` (get-or-create `{deciding, decision?}`), `submitDecision(approvalId, decision, answers?)` from `./store.ts`; `submitApprovalDecision` from `services/approvals-api.ts` (stubs `globalThis.fetch` — save/restore `realFetch` in `afterEach`, the documented leak pattern).
- Produces: coverage for the five outcome branches (`decided` → optimistic `decision` + success toast path; `conflict`; `not_found`; `unauthorized`; network `error`) and the `deciding` flag being true only during the in-flight call (resolve the fetch stub manually inside the test).

- [ ] **Step 1: Write the failing tests** — one per outcome: stub fetch to return `{status: 202}` / 409 / 404 / 401 / reject; assert the returned outcome string, `approvalUi(id).decision` after success (and unchanged after failures), `deciding === false` after every settle.
- [ ] **Step 2: Run** `bun test apps/web/src/features/approvals/store.test.ts` — expect FAIL if assertions expose a store bug, else they may PASS immediately (this task pins behavior; a failure is a real bug to fix in `store.ts`).
- [ ] **Step 3: Fix anything the tests exposed** in `store.ts`; keep VN toast strings untouched.
- [ ] **Step 4: Run** the store test file, then `bun run typecheck`.
- [ ] **Step 5: Commit** `git commit -m "test: cover the approvals store decision outcomes"`

### Task 4: recordApprovalDecision reuses insertPendingSync (F3)

**Files:**
- Modify: `packages/control-db/src/approvals.ts` (the outbox INSERT inside the decision transaction, ~lines 167–183), possibly `packages/control-db/src/command-outbox.ts` (align the shared column list)
- Test: `packages/control-db/src/approvals.test.ts` (existing atomicity tests must stay green unchanged)

**Interfaces:**
- Consumes: `insertPendingSync(record)` in `command-outbox.ts` — same columns `recordApprovalDecision` currently inlines.
- Produces: one INSERT implementation. If `insertPendingSync`'s shape does not fit the in-transaction call exactly, reshape `insertPendingSync` (it has no other callers) — do not keep two column lists.

- [ ] **Step 1: Run** `bun test packages/control-db/src/approvals.test.ts` — green baseline.
- [ ] **Step 2: Replace the inlined INSERT** with a call to `insertPendingSync` (reshaping it if needed); delete dead code.
- [ ] **Step 3: Run** the same file — PASS unchanged (behavior is identical by construction).
- [ ] **Step 4: Commit** `git commit -m "refactor: reuse insertPendingSync in the approval decision tx"`

### Task 5: Refuse approval.respond with no live router (F2)

**Files:**
- Modify: `apps/runner/src/execution/run-controller.ts` (~line 173 — the fallback `new ApprovalRouter({ db, append: () => {} })`)
- Test: `apps/runner/src/execution/run-controller.test.ts`

**Interfaces:**
- Consumes: the existing `approval.respond` handling branch (router lookup → `router.respond(...)` → receipt).
- Produces: when `router === undefined`, the branch returns `{ ...receipt(parsed, true), reason: "unknown" }` **without** touching the runner-db row — mirroring the existing refused-respond shape, so the mute no-op-append router disappears.

- [ ] **Step 1: Write the failing test** — execute a run whose `router` factory returns `undefined` (or omit the router so the fallback path is reached), deliver an `approval.respond` command for a pending approval row, assert the receipt carries `reason: "unknown"` AND the row's state is still `"pending"` (nothing resolved, nothing emitted).
- [ ] **Step 2: Run** `bun test apps/runner/src/execution/run-controller.test.ts` — FAIL (current code resolves the row silently).
- [ ] **Step 3: Implement** the refusal; delete the fallback router construction.
- [ ] **Step 4: Run** the file — PASS; then `bun test apps/runner` for the neighborhood.
- [ ] **Step 5: Commit** `git commit -m "fix: refuse approval.respond when no router is registered"`

### Task 6: abandon_approval closes orphaned pending approvals (F7)

**Files:**
- Modify: `packages/control-db/src/approvals.ts` (new helper), `apps/control-server/src/websocket/runner/runner-gateway.ts` (the reconcile-apply site ~line 444 where `RunRegistry.apply` runs)
- Test: `packages/control-db/src/approvals.test.ts`, `apps/control-server/src/websocket/runner/runner-gateway.test.ts` (or the file where reconcile actions are tested — follow the existing reconcile tests)

**Interfaces:**
- Consumes: `RunReconcileAction` `abandon_approval` (emitted by `packages/protocol/src/reconcile.ts:151-163` when the server sees `waiting_for_approval` but the runner reports `approvalsAlive: false`); the action's run/attempt ids (read the payload shape there — close by `attempt_id` if present, else by `run_id`).
- Produces: `expirePendingApprovals(db, attemptId | runId selector)` in control-db — `UPDATE approvals SET state = 'expired' WHERE ... AND state = 'pending'`, returning the number of rows closed; the gateway applies it when handling the action, in the same place it applies `mark_interrupted`.

- [ ] **Step 1: Write the failing control-db test** — seed a pending approval (+ a resolved one and one from another attempt), run the helper, assert only the pending one for the selector flipped to `expired` and the count is exact.
- [ ] **Step 2: Run** `bun test packages/control-db/src/approvals.test.ts` — FAIL (helper missing).
- [ ] **Step 3: Implement** the helper.
- [ ] **Step 4: Write the failing gateway test** — feed a reconcile payload that produces `abandon_approval` for a run with a pending approval row; assert the row is `expired` after the reconcile is applied (and the registry's run still resolves via the paired `mark_interrupted`).
- [ ] **Step 5: Run** — FAIL, then wire the helper into the gateway's apply path; PASS.
- [ ] **Step 6: Commit** `git commit -m "fix: close projected approvals when reconcile abandons them"`

### Task 7: Protocol — hello/reconcile carry declared workspaces

**Files:**
- Modify: `packages/protocol/src/handshake.ts` (`HelloPayload` type + `negotiateHello` validation), `packages/protocol/src/reconcile.ts` (reconcile payload type + validation), `packages/protocol/src/index.ts` (export the shared type)
- Test: `packages/protocol/src/handshake.test.ts`, `packages/protocol/src/reconcile.test.ts`

**Interfaces:**
- Produces: `export type DeclaredWorkspace = { workspaceId: string; path: string }`; hello and reconcile payloads gain optional `workspaces?: DeclaredWorkspace[]`. Validation: absent → treated as `[]` (back-compat with runners built before this change); present → must be an array of objects with non-empty string `workspaceId` and `path`, else the hello/reconcile is malformed (same refusal path the validators already use). The negotiated result exposes the parsed `workspaces` array. `minProtocolVersion` stays 1.

- [ ] **Step 1: Write the failing tests** — hello with `workspaces: [{workspaceId: "default", path: "/srv/proj"}]` negotiates and exposes the array; hello without the field negotiates with `workspaces: []`; hello with `workspaces: "default"` or a non-string path is refused as malformed; same three cases for reconcile.
- [ ] **Step 2: Run** `bun test packages/protocol` — FAIL.
- [ ] **Step 3: Implement** the type + validation in both payloads.
- [ ] **Step 4: Run** — PASS; `bun run typecheck`.
- [ ] **Step 5: Commit** `git commit -m "feat: carry declared workspaces in hello and reconcile"`

### Task 8: Runner declares its workspaces

**Files:**
- Modify: `apps/runner/src/workspaces/workspaces.ts` (add `declaredWorkspaces`), `apps/runner/src/daemon.ts` (hello ~line 124 and the reconcile payload both include `workspaces`)
- Test: `apps/runner/src/workspaces/workspaces.test.ts` (or the file where `defaultWorkspaceResolver` is tested), `apps/runner/src/daemon.test.ts`

**Interfaces:**
- Consumes: `CC_WEB_RUNNER_DEFAULT_WORKSPACE` env (already wired in `bootstrap/main.ts:118`).
- Produces: `export function declaredWorkspaces(env: string | undefined): DeclaredWorkspace[]` — blank/absent env → `[]`; otherwise `[{ workspaceId: "default", path: <trimmed env> }]`. The resolver (`defaultWorkspaceResolver`) stays as-is — declaration and resolution share the same env so they can never disagree. Daemon hello and reconcile payloads carry `workspaces: declaredWorkspaces(env)`; pass the same value the resolver was built from into the daemon so there is one source.

- [ ] **Step 1: Write the failing tests** — `declaredWorkspaces(undefined)` → `[]`; `declaredWorkspaces("")` → `[]`; `declaredWorkspaces("/srv/proj")` → `[{workspaceId: "default", path: "/srv/proj"}]`; daemon hello payload contains the array when env is set (extend the existing hello/reconcile payload test).
- [ ] **Step 2: Run** `bun test apps/runner/src/workspaces apps/runner/src/daemon.test.ts` — FAIL.
- [ ] **Step 3: Implement** both pieces; wire the daemon so hello and reconcile carry the identical array.
- [ ] **Step 4: Run** `bun test apps/runner` — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: runner declares its workspaces in the handshake"`

### Task 9: Control plane stores declared workspaces

**Files:**
- Modify: `packages/control-db/src/db.ts` (migrate — new table after `approval_decisions`), `packages/control-db/src/index.ts`, new file `packages/control-db/src/workspaces.ts`, `apps/control-server/src/websocket/runner/runner-gateway.ts` (`GatewayOptions` + the hello/reconcile apply sites), `apps/control-server/src/server.ts` (wiring)
- Test: `packages/control-db/src/workspaces.test.ts`, the runner-gateway test file

**Interfaces:**
- Produces:
  - Table `workspaces (runner_id, workspace_id, path, registered_at, PRIMARY KEY (runner_id, workspace_id))` in `migrate()`.
  - `upsertRunnerWorkspaces(db, runnerId: string, workspaces: Array<{workspaceId: string; path: string}>): void` — **declarative replace**: one transaction that deletes every row for `runnerId` then inserts the declared set (empty array removes all rows for that runner).
  - `workspacesForOwner(db, ownerId: string): Array<{workspaceId, runnerId, path, createdAt}>` — join `runners`, `WHERE owner_id = ? AND revoked_at IS NULL`, ordered by runner `created_at` then `workspace_id`.
  - `GatewayOptions.onWorkspaces?: (runnerId: string, workspaces: Array<{workspaceId: string; path: string}>) => void` — invoked once per successful hello and per successful reconcile, with the parsed array; `server.ts` wires it to `upsertRunnerWorkspaces(options.db, …)`.

- [ ] **Step 1: Write the failing control-db tests** — upsert inserts two rows; a second upsert with one workspace leaves exactly that row (stale row gone); upsert with `[]` empties the runner's rows; `workspacesForOwner` excludes revoked runners and other owners' runners.
- [ ] **Step 2: Run** `bun test packages/control-db/src/workspaces.test.ts` — FAIL; implement table + functions; PASS.
- [ ] **Step 3: Write the failing gateway test** — hello (and reconcile) with declared workspaces triggers `onWorkspaces` with the parsed array exactly once per handshake step; a hello without the field triggers it with `[]`.
- [ ] **Step 4: Run** — FAIL; implement the option + call sites + server wiring; PASS; `bun run typecheck`.
- [ ] **Step 5: Commit** `git commit -m "feat: store runner-declared workspaces on the control plane"`

### Task 10: GET /api/workspaces

**Files:**
- Create: `apps/control-server/src/routes/workspaces-routes.ts`, `apps/control-server/src/routes/workspaces-routes.test.ts`
- Modify: `apps/control-server/src/server.ts` (mount the route)

**Interfaces:**
- Consumes: `workspacesForOwner` (Task 9); the auth + Origin pattern from `runners-routes.ts`/`runs-routes.ts`.
- Produces: `GET /api/workspaces` → 200 `{"workspaces": [{workspaceId, runnerId, path, createdAt}]}`, `Cache-Control: no-store`; the same refusal vocabulary as sibling routes (403 foreign Origin, 401 unauthorized).

- [ ] **Step 1: Write the failing tests** — happy path returns the owner's workspaces with `no-store`; foreign Origin → 403 before the cookie is read; no cookie → 401; a second owner's workspaces never appear.
- [ ] **Step 2: Run** `bun test apps/control-server/src/routes/workspaces-routes.test.ts` — FAIL.
- [ ] **Step 3: Implement** the route + mount it.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: list owner workspaces over the API"`

### Task 11: Model rides the dispatch (end-to-end)

**Files:**
- Modify: `apps/control-server/src/routes/runs-routes.ts` (body parse + validation), `packages/control-db/src/scheduler.ts` (`DispatchRequest.model?` + run.start payload conditional spread), `apps/runner/src/execution/executor.ts` (parse `model` from the payload record next to `permissionMode`, ~line 95), `packages/agent-adapter/src/index.ts` (`SdkStreamInput.model?` → `options["model"]`)
- Test: `apps/control-server/src/routes/runs-routes.test.ts`, `packages/agent-adapter/src/index.test.ts` (or its existing file), `apps/runner/src/execution/executor.test.ts`

**Interfaces:**
- Consumes: the `permissionMode` path end-to-end — copy it field-for-field.
- Produces: dispatch body accepts optional `model`; valid values exactly `{"sonnet", "opus", "haiku"}` (the set the composer offers); anything else → 400 with an empty outbox. `DispatchRequest.model?: string`; run.start payload gains `model` only when present (conditional spread); `SdkStreamInput.model?: string`; the adapter sets `options["model"]` only when defined (§8.1: absent override is omitted — the SDK default is "inherit"). The executor parses `model` from the payload as an optional non-empty string, absent otherwise.

- [ ] **Step 1: Write the failing route tests** — `model: "sonnet"` reaches the outbox `run.start` payload as `"model": "sonnet"`; `model: "yolo"` → 400 and empty outbox; `model` absent → payload has no `model` key.
- [ ] **Step 2: Run** the route test file — FAIL; implement route + `DispatchRequest` + payload spread; PASS.
- [ ] **Step 3: Write the failing executor/adapter tests** — executor payload with `model` reaches the fake sdk input as `model`; adapter input with `model` sets `options["model"]` (assert on the captured options the fake query fn receives); absent → key absent.
- [ ] **Step 4: Run** both files — FAIL; implement; PASS; `bun run typecheck`.
- [ ] **Step 5: Commit** `git commit -m "feat: model choice rides the run payload to the SDK"`

### Task 12: Dispatch pins the runner through the workspace

**Files:**
- Modify: `apps/control-server/src/routes/runs-routes.ts` (body gains `runnerId?`; placement block replaces the first-ready loop, ~lines 85–115)
- Test: `apps/control-server/src/routes/runs-routes.test.ts`

**Interfaces:**
- Consumes: `workspaces` table + `upsertRunnerWorkspaces` (Task 9) for seeding; `runnerGateway.stateOf`.
- Produces — placement rules, in order:
  1. `runnerId` present in the body → must be an existing, non-revoked runner owned by the authorized user, else 400 `unknown_runner`; must report `ready`, else 503 `runner_offline`/`runner_not_ready` as today.
  2. `workspaceId` present (or defaulted `"default"`) → candidate rows are the owner's non-revoked runners declaring that `workspace_id`. No candidates → 400 `unknown_workspace`. If `runnerId` was also sent and is not among the candidates → 400 `unknown_workspace`.
  3. Runner selection: with `runnerId` sent, that one; otherwise deterministic — among candidates in runner `created_at` order, the first whose state is `ready`; if none is ready, 503 `runner_offline` (nothing connected) / `runner_not_ready` (connected but not reconciled), same semantics as today.
  4. `workspaceId` absent from the body → legacy behavior preserved: candidates = all owner's non-revoked runners, first ready wins, `"default"` rides the payload (existing sessions keep today's placement until the session-pin milestone).
- 400 bodies use the bare-text convention (`unknown_workspace`, `unknown_runner`).

- [ ] **Step 1: Write the failing tests** — (a) two runners, workspace declared on runner B only → run lands on B's outbox row; (b) `workspaceId: "nope"` → 400 `unknown_workspace`, empty outbox; (c) `runnerId` of another owner → 400 `unknown_runner`; (d) `runnerId` valid but that runner doesn't declare the workspace → 400 `unknown_workspace`; (e) declared on both, no `runnerId`, first runner not ready, second ready → second wins; (f) absent `workspaceId` → legacy first-ready dispatch still works (existing test already covers; keep green); (g) revoked runner never candidates.
- [ ] **Step 2: Run** the route test file — FAIL; implement; PASS (all pre-existing dispatch tests stay green).
- [ ] **Step 3: Run** the full control-server suite + `bun run typecheck`.
- [ ] **Step 4: Commit** `git commit -m "feat: dispatch pins the runner through the chosen workspace"`

### Task 13: Composer — real selects, options-object startRun

**Files:**
- Modify: `apps/web/src/services/runs-api.ts` (`startRun(sessionId, options)`), `apps/web/src/services/runs-api.test.ts`, `apps/web/src/components/Composer.vue`, new `apps/web/src/services/workspaces-api.ts` + `workspaces-api.test.ts`
- Test: service test files (bun test), then typecheck + build

**Interfaces:**
- Consumes: `GET /api/workspaces` (Task 10), `GET /api/runners` (existing), the dispatch body of Tasks 11–12.
- Produces:
  - `startRun(sessionId: string, run: { prompt: string; workspaceId?: string; runnerId?: string; permissionMode?: string; model?: string }): Promise<...same outcome union...>` — body built with conditional spreads; replaces the 4-positional-param signature (update its existing tests and the single caller).
  - `fetchWorkspaces(): Promise<Array<{workspaceId, runnerId, path, createdAt}>>` mapping 401 → `"unauthorized"`, other non-OK → `"error"`, following `runs-api.ts`'s mapper style.
  - Composer state: `runners` (existing) + `workspaces` ref from `fetchWorkspaces()`. The project select's value is the composite `` `${runnerId}/${workspaceId}` `` (UUIDs contain no `/`), labeled with `path` (mono) and the runner id as muted secondary text. Rules: selecting a project while a specific runner is chosen whose id differs from the project's runner → the runner select switches to the project's runner; selecting a specific runner filters the project options to that runner's workspaces and resets an out-of-list project to its first entry. `model` sends only when not `"default"`; `workspaceId`/`runnerId` are sent only on the new-session screen (existing sessions keep today's body minus the removed positional params).

- [ ] **Step 1: Write the failing `workspaces-api.test.ts`** (200 mapping, 401 → `"unauthorized"`, 500 → `"error"`) and update `runs-api.test.ts` for the options-object signature + `model`/`runnerId` in the body and their absence when unset.
- [ ] **Step 2: Run** `bun test apps/web/src/services` — FAIL; implement both services; PASS.
- [ ] **Step 3: Rework Composer** per the state rules above; keep all VN labels; keep the branch select local (unchanged); keep `permissionTone`.
- [ ] **Step 4: Verify** `bun run typecheck` + `cd apps/web && bun run build` — clean.
- [ ] **Step 5: Commit** `git commit -m "feat: composer selects drive real placement and model"`

### Task 14: Gates, ledger, push

**Files:**
- Modify: `.superpowers/sdd/<this milestone's ledger dir>/progress.md` (local only)

- [ ] **Step 1: Full gates** — `bun test` (expect ≥ 545 pass, 0 fail), `bun run typecheck`, `bunx biome check .` (exit 0), `cd apps/web && bun run build`.
- [ ] **Step 2: Ledger** — per-task completion lines + any rulings made during execution.
- [ ] **Step 3: Push** `git push origin main`.
- [ ] **Step 4: Memory handoff + Vietnamese report** (no browser E2E this milestone per the owner's call; the fake runner at `/tmp/cc-web-fake-runner.ts` needs a `workspaces` declaration added before the NEXT live demo pass — local file, never committed).
