# Run Queue and Multi-Run Runners Design

## Intent

Two capabilities, one change:

1. A Runner may execute **N runs concurrently** instead of exactly one.
2. A prompt submitted to a session that already has an active run is **queued durably** and starts by itself when the session's slot frees, instead of being refused with `409 session_busy`. The operator can see the queue and remove an entry.

The operator asked for a real run behind the queue, not a prompt held in the browser: the queued entry has a `runId` immediately, survives a refresh and another tab, and can be cancelled like any run.

## Goals

- Enqueueing a second prompt on a busy session answers `202` and returns a run the operator can watch, cancel, and find again after reload.
- The queue drains in FIFO order per Runner, skipping entries whose own session or workspace is still occupied.
- A Runner advertises and honours its own concurrency limit; the server never dispatches past it.
- Cancelling a queued run removes it from the queue and from the outbox; it never reaches the Runner.
- Existing semantics for new sessions, pins, scheduled tasks, attachments, and the journal are unchanged.

## Non-goals

- Reordering the queue by operator action, priority lanes, or fairness across sessions.
- Running two runs concurrently **in the same session**. Both would resume and write the same SDK conversation. Serialization per session is a hard invariant, at every N.
- A queue that survives the deletion of its session, runner, or pinned workspace — deletion retires queued entries along with the session.
- Cross-runner re-placement. A queued run stays on the runner its session is pinned to.
- Runner-side autonomous queueing. Placement and admission stay server-owned (see Approaches).

## Anti-goals

- A queued entry the operator cannot see or cancel.
- A `202` that later disappears without a journal record or an operator-visible reason.
- Two dispatchers (route and schedule tick) disagreeing about what counts as capacity.
- Re-delivering a promoted command after it has been rejected for a transient reason, forever.

## Constraints

- `active_runs` keeps `CREATE UNIQUE INDEX active_runs_one_per_session`: at most one **accepted** run per session.
- The outbox is the only durable home for a command's payload, including the sealed profile payload (`payload_secure`) and the redaction rules (§18.1). A queue table of its own would duplicate that.
- The runner's workspace lock (`beginAttempt`) is exclusive per canonical path. Two sessions pinned to the same workspace on the same runner can never run at once, regardless of N. The server does not see this lock, so admission must avoid it rather than discover it.
- The journal is the authority on outcomes: an active slot frees when a terminal event commits, not when a cancel is requested.
- `packages/control-db` and `packages/runner-db` are the only schema owners; control-server and runner must not write ad-hoc SQL.
- No service on the operator's machine is touched by this design.

## Approaches

**A — queued = a durable outbox command not yet accepted into `active_runs` (chosen).**
`Scheduler.dispatch` always enqueues, then tries to insert `active_runs`. Insert succeeds → accepted and drained; insert blocked (session busy, workspace busy, runner at capacity) → the row stays `pending` and is a queue entry. A `promote(runnerId)` step, run after every slot release and on `ready`, walks the runner's pending `run.start` rows oldest-first and accepts what fits.

*Trade-off:* no new table, no duplicated payload/sealing/fingerprint logic, cancel of a queued run is one `markRejected`. Cost: "queued" is a derived state (pending row, no active row), so every reader must agree on that definition, and the dispatcher needs a hard rule — send only commands that hold an `active_runs` slot.

**B — a `queued_runs` table.** Explicit rows, obvious queries. Rejected: it duplicates the payload, the sealed secure payload, the fingerprint, and the retry state of a command that is already durable; promotion becomes a two-table transaction with its own race.

**C — the Runner queues locally.** Rejected: the server would still have to treat a sent-but-queued run as active to keep its own books straight; the web could not see the queue without new frames; cancelling a queued run would become a runner concern; and the workspace lock lives on the runner, so the server would be guessing at capacity it cannot observe.

## Invariants

1. At most one **accepted** run per session (`active_runs` unique index). A session may additionally hold any number of queued runs.
2. At most one accepted run per `(runner_id, workspace_id)` — derived by joining `active_runs.session_id` to `sessions.workspace_id`. This mirrors the runner's workspace lock instead of colliding with it.
3. At most `maxConcurrentRuns` accepted runs per runner, where the number is the one negotiated in `hello.ok` (`Math.min(runner declaration, server policy)`), not a literal.
4. The dispatcher delivers a `run.start` only while that command holds an `active_runs` row. A pending command with no active row is queue state, never wire state.
5. Queue order is `command_outbox.created_at` among eligible rows. An ineligible head is skipped, never blocking an eligible successor.
6. A queued `run.start` never carries a frozen `resumeSessionId`. It must continue the conversation as it stands when it starts, not as it stood when the operator typed (see "Resume semantics").
7. A terminal event, a rejected start, or a reconcile interruption frees the slot and immediately runs promotion — no timer is required for correctness.
8. Every retry is bounded: a command that keeps being rejected for a transient reason is retired after a fixed number of requeues and surfaces as a journaled failure, never loops silently.
9. `409 session_busy` remains reachable only for callers that explicitly disable queueing (the scheduled-task tick). The operator-facing route never returns it.
10. Queueing absorbs **contention**, not **absence**: a run is queued only when its target runner is live and `ready`. An offline or un-reconciled runner keeps today's `503` (see "What is queueable").
11. Every queued run has a pin from the moment it is accepted: the pin, the outbox row, and any `active_runs` insert commit in one synchronous transaction, so a queued session is never placement-less and two racing dispatches cannot pin it differently.

## State model

`command_outbox.delivery_state` gains one value, `queued`, used only for `run.start`:

```
queued ──promote──▶ pending ──sent──▶ accepted
  │                    │                └─ rejected
  │                    └─ rejected (expired / cancelled / permanent runner refusal)
  └─ rejected (cancelled by operator, session/runner deleted, requeue ceiling)
```

A **queued** row is a run whose `runId` and `attemptId` are minted and bound to a session and workspace, but which holds no `active_runs` row. A **pending** row holds one and is deliverable. Only those two facts distinguish the states; both are `run.start` commands with the same payload shape.

- `dispatch` writes the row as `queued` when admission is blocked, `pending` when it is not.
- `promote` flips `queued → pending` and inserts `active_runs` in one transaction; a unique-index loss rolls the flip back (the row stays `queued`).
- `pendingFor` (the drain query) keeps returning `pending` and `sent` only. `queued` rows are invisible to the dispatcher by construction, which is invariant 4 enforced by query rather than by discipline in the dispatcher loop.
- A queued run cancelled by the operator is `rejected` with reason `cancelled`. Nothing is journaled: a run that never reached a runner has no attempt on any machine, and minting a synthetic terminal event for it would put a transcript entry in a session that never ran (§12.1: the journal records what a runner did). The queue row disappearing, plus the `202` from the cancel call, is the operator-visible outcome. This is the one deliberate exception to "every run ends in a journal event", and it is stated so nobody later reads it as a bug.

## What is queueable

Queueing is a substitute for a refusal, so it covers exactly the refusals that mean *"not yet"* on a runner that is **present**:

| Situation today | After |
|---|---|
| `session_busy` (an accepted run holds the session) | queued |
| `runner_at_capacity` | queued |
| new: `(runner, workspace)` already has an accepted run | queued |
| `runner_offline`, `runner_not_ready`, no ready candidate | unchanged `503` |
| `duplicate_run`, `profile_secrets_unavailable`, validation | unchanged `4xx` |

A queue entry is bound to a runner at submit time (the session's pin, or the placement chosen for a new session). A runner that is not `ready` cannot be bound to, so its work is refused rather than parked — invariant 10, which the operator chose explicitly. The alternative, queueing against an absent runner, would turn a `202` into a promise the server cannot keep about *when* the run happens, and would leave the pin/workspace validation that already ran against a live declaration meaningless. A dispatch that queues therefore never waits for hardware to come back; it waits for a slot on hardware that is there.

Once a run is already queued, a runner that goes offline is not a cancel: the row is durable, `promote` returns early while the runner is not `ready`, and the next `ready` picks the queue back up. The distinction is "we accepted it while the runner was present" versus "we never accepted it".

A scheduled task keeps its existing "not now, keep the row due" semantics and passes `queue: false` (see "Scheduler contract").

## Pinning a queued run

Today `ensureSessionPin` runs only for an accepted dispatch, in the same synchronous continuation as the `active_runs` insert, so a losing race never relocates a session. A queued run still needs a pin: `promote` must know which `(runner, workspace)` to check for conflicts and which runner to admit on, the route must refuse a later dispatch that contradicts it, and the read models resolve ownership from it.

Rule (invariant 11): `dispatch` resolves the pin **before** it awaits the outbox enqueue — a read, no write — and then, in one synchronous, non-async section, writes the pin (INSERT OR IGNORE) and inserts `active_runs` when admitted. A queued dispatch writes the pin and leaves `active_runs` empty. Because the pin write is `INSERT OR IGNORE` and both racing dispatches are for the same session, the second one acquires the *first* pin rather than its own; the scheduler re-reads the pin after writing and uses the pinned `(runner, workspace)` for admission, failing with `session_pinned` when the caller's placement contradicts it. This removes the "enqueue hashes asynchronously" hazard the current comment documents.

## Admission and promotion

`promote(runnerId)` is a server-side step, idempotent and single-flight per runner:

1. Read the runner's negotiated state and `maxConcurrentRuns`. Not ready → return.
2. Count accepted runs for the runner. At the limit → return.
3. Select candidate `run.start` rows with `delivery_state = 'queued'` for this runner, ordered by `created_at`, and, for each in order, skip it when:
   - its session already has an accepted run, or
   - its `(runner_id, workspace_id)` already has an accepted run (including one accepted earlier in this same pass).
4. For each remaining candidate, insert `active_runs` and flip the row to `pending` in one transaction. Stop when the capacity limit is reached.
5. Call the dispatcher's drain once, after the promotions, so delivery stays part of the same call.

Single-flight is a per-runner in-memory flag plus a re-run marker: a promotion requested while one is executing sets `again`, and the executing pass loops once more instead of nesting. Two concurrent terminal events therefore cannot interleave their transactions or double-admit, and no request is lost.

Trigger points, all already existing seams:

| Trigger | Where |
|---|---|
| A terminal event commits | `onEvents` loop, replacing today's bare `scheduler.release` |
| A runner rejects a `run.start` | `onRejectedStart`: release, then promote |
| A runner becomes `ready` | `onReady`: promote, then drain (reconcile may have freed capacity) |
| Reconcile terminalizes a run | see "Reconcile" below |
| A new dispatch is accepted | `dispatch` itself; no promotion is needed |
| A queued run is cancelled | nothing to promote (it held no slot) |

`release(runId)` returns the runner id it freed (or undefined) so callers can promote without a second query.

## Reconcile

Reconcile currently marks interrupted runs in the in-memory `RunRegistry` and frees nothing: an accepted run whose runner crashed holds its session's `active_runs` row — and now, its workspace's admission — forever. Queueing turns that latent leak into a deadlock, so it must be closed here.

`RunRegistry.apply` reports which run ids it moved to a terminal observation (a return value listing them; `adopt_terminal` and `mark_interrupted` are the two cases). The gateway, which already applies actions and already owns an `onAbandonApproval` hook, gains a sibling hook:

```
onRunTerminal(runnerId, runId)   // gateway → server
```

The server wires it to `scheduler.release(runId)` followed by `promote(runnerId)`. Ordering is fixed by the gateway: every action is applied and its hook fired **before** `connection.state = "ready"` and before `onReady`, so by the time `onReady` promotes, the slots are already freed and a second promotion is a no-op. The gateway still knows nothing about the scheduler; it only reports the fact "this run is terminal now". A reconcile that terminalizes nothing fires no hook.

## Scheduler contract

`scheduler.dispatch(request, capacity, options?)` grows one option, `queue?: boolean` (default `true`):

| Blocked by | `queue: true` (routes) | `queue: false` (schedule tick) |
|---|---|---|
| session busy | `{ ok: true, queued: true }` | `{ ok: false, reason: "session_busy" }` |
| runner at capacity | `{ ok: true, queued: true }` | `{ ok: false, reason: "runner_at_capacity" }` |
| workspace busy | `{ ok: true, queued: true }` | `{ ok: false, reason: "workspace_busy" }` |
| duplicate, offline, unreconciled | refusal, as today | refusal, as today |

The tick keeps its current behaviour unchanged — `decision.ok === false` means "leave the row due, retry next tick" — and gains the new `workspace_busy` refusal so a schedule can never be double-placed onto a workspace that is running. The tick does use the negotiated `maxConcurrentRuns` (the literal 1 goes away), but it never queues: a missing fire is retried by the clock, and a queued schedule would fire late without the tick knowing.

## Requeue ceiling and journaled failure

`onRejectedStart` classifies the runner's reason:

- **Transient — `workspace_busy`, `draining`**: `release`, `outbox.requeue(commandId)` (a new transition: `rejected → queued`, incrementing a durable `requeue_count` column), then `promote`. The count is a column, not `attempt_count`, so it survives restarts and is not confused with delivery attempts.
- **Permanent — anything else** (`unknown_workspace`, `unsupported_command`, `attempt_exists`, protocol errors): reject as today, keep `reopenRejectedSchedule`.
- **Ceiling — `requeue_count > 50`**: do not requeue. Journal a terminal event for the run through the existing `appendServerEvent` seam (the same one `abandonAttemptApprovals` uses for server-authored terminals): `run.failed` with `{ reason: "queue_abandoned", detail: <last runner reason> }`, attempt id = the run's minted `attemptId`, and release the slot. This run never reached a runner, so its attempt has no local rows anywhere; `appendServerEvent` allocates in the server-owned sequence range (`SERVER_EVENT_SEQUENCE_BASE`), which is exactly what that range exists for. The UI renders it as a failed turn with the prompt, so the operator sees what happened to the message they sent.

The ceiling is deliberately high: a transient refusal that repeats 50 times means the runner is admitting work it cannot run, which is worth an operator-visible failure rather than an invisible loop.


## Capacity: where N comes from

Today the number 1 is hard-coded in three places. The negotiated value in `hello.ok` is discarded after negotiation.

- `RunnerGateway` stores the negotiated `maxConcurrentRuns` on the connection and exposes `maxConcurrentRunsOf(runnerId: string): number | undefined` (undefined when no live connection).
- `apps/control-server/src/routes/runs-routes.ts` and `apps/control-server/src/scheduling/schedule-loop.ts` stop passing a literal base; the route reads the negotiated value and the scheduler's `capacityFor` still counts `active_runs`.
- `apps/runner/src/daemon.ts` `helloFrame` advertises `CC_WEB_RUNNER_MAX_CONCURRENT_RUNS`, default **1**, clamped by the server policy (4). Default 1 means an existing installation behaves exactly as today until the operator opts in; the queue is still useful at N=1 because it serializes a session instead of rejecting the second prompt. The runner needs no scheduler of its own: `RunController` already tracks concurrent attempts in a map, and the workspace lock is the real limiter for same-workspace work.

## Resume semantics

A queued run's payload is built at submit time. `resumeSessionId` in it names the SDK conversation the browser knew then; by the time the run starts, the preceding run in the same session may have produced a newer conversation id. Freezing the old value would resume a stale transcript.

Rule: when `dispatch` queues a run (admits it later), it persists the payload **without** `resumeSessionId`. The runner then resolves `sdkSessionIdForSession(db, sessionId)` at execution — its own latest — exactly as it already does when the field is absent. Runs admitted immediately keep the field, so the "resume this specific session" choice on the new-session page is unchanged.

## API surface

- `POST /api/sessions/:sessionId/runs` keeps its shape. The `202` body gains `queued: boolean`.
- `GET /api/sessions/:sessionId/queue` → `{ runs: [{ runId, attemptId, prompt, enqueuedAt }] }`, owner-scoped, `Cache-Control: no-store`, oldest first. It reads queued `command_outbox` rows for that session and returns only the display fields — never the profile, workspace path, or any part of `payload_secure`.
- `POST /api/runs/:runId/cancel` extends to queued runs: `Scheduler.cancel` checks `active_runs` first (existing behaviour) and then a queued `run.start` for that run id, retiring it with reason `cancelled` and answering `202`.
- Existing `duplicate_run` detection counts both accepted and queued rows for the run id.

## Web UI

The strip above the composer currently appears when subagents exist and carries an "active" button plus a "History" button. The History button there is removed — the bottom toolbar keeps its own History entry point. The strip now renders when `subagents.total > 0 || queuedRuns.length > 0`, and its right side becomes a **"Waiting (N)"** button that opens a popover anchored above the composer, styled and behaving like the `/` slash-command menu (same `ScrollArea`, max height, Escape/click-outside to close, `role="listbox"`):

```
┌────────────────────────────────────────────────────┐
│ ● 2 subagent (1 running · 1 done)   Xem subagent ↗  │
│                                        Waiting (2) │
└────────────────────────────────────────────────────┘
        ▲ click
   ┌──────────────────────────────────────────┐
   │ Đang chờ · chạy khi lượt hiện tại xong    │
   │ ┌──────────────────────────────────────┐ │
   │ │ sửa lỗi test auth                    × │ │
   │ │ 2 phút trước                         │ │
   │ ├──────────────────────────────────────┤ │
   │ │ thêm retry cho hàng đợi              × │ │
   │ │ 1 phút trước                         │ │
   │ └──────────────────────────────────────┘ │
   └──────────────────────────────────────────┘
```

- Each row shows the prompt (single line, truncated, full text in `title`) and a relative enqueue time. `×` cancels that run through the existing cancel endpoint.
- The list is fed by `GET /api/sessions/:id/queue` on session mount and after a successful send, and pruned when the journal carries `run.started` for a queued `runId`. No new socket frame: `run.started` is already delivered.
- A successful send whose `202` says `queued: true` shows a short confirmation ("prompt queued") instead of the silent success path, so the operator knows the message did not start yet.
- Empty after a cancel → the strip falls back to the subagent-only layout, and disappears entirely if there are none.

## Failure modes

| Situation | Behaviour |
|---|---|
| Runner at capacity | Run is queued; `202 { queued: true }`. |
| Runner offline / not ready when the prompt arrives | Refused `503`, as today. |
| A queued run's runner goes offline before it is promoted | Row stays `queued`; `promote` is a no-op until the runner is `ready` again. |
| Session already has an accepted run | Run is queued; the queued entry is skipped during promotion until that run ends. |
| Another session on the same workspace is running | Run is queued; skipped until the workspace frees. |
| Runner rejects a promoted start with `workspace_busy` / `draining` | `active_runs` freed, command returned to `queued`, promoted again on the next trigger. Requeue count is bounded (50); past it the command is retired and the server journals `run.failed { reason: "queue_abandoned" }`, which the browser renders as a failed turn. |
| Runner rejects a promoted start with `unknown_workspace` or another permanent reason | Slot freed, command rejected, existing `reopenRejectedSchedule` path applies for schedules; nothing is journaled for a user run, matching today. |
| Queued command expires (outbox `expires_at`) | `retireExpired` rejects it; it never starts. |
| Session deleted | `deleteSession` already removes active rows and outbox rows; queued entries go with them. |
| Runner deleted | Same, via `deleteRunner`. |
| Server restarts with queued rows | They are durable; the next `ready` (or the first release) promotes them. No in-memory queue exists to lose. |
| Runner reconnects after a crash with accepted runs still in `active_runs` | Reconcile `mark_interrupted` now releases those rows and promotes; this gap exists today and would otherwise deadlock the queue. |

## Sidebar and counters

A session whose first run is queued has no `active_runs` row and possibly no events, so `listSessions` would omit it. Its `dispatched` union must also read `command_outbox` rows with `kind = 'run.start'` in `queued`/`pending`/`sent`. `stats.ts` run/session counts follow the same rule so the dashboard does not undercount a run the operator can see in the rail.

## Schema and migration

No new table. Two additive columns on `command_outbox` (via the existing `addColumnIfMissing` pattern) and one new `delivery_state` value; `delivery_state` is already a free `TEXT` column with no CHECK constraint, so existing databases need no rewrite:

```sql
ALTER TABLE command_outbox ADD COLUMN requeue_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE command_outbox ADD COLUMN queue_snapshot TEXT;   -- pinned runner/workspace for a queued row

CREATE INDEX IF NOT EXISTS command_outbox_queued
  ON command_outbox (runner_id, created_at)
  WHERE delivery_state = 'queued';
```

`queue_snapshot` holds `{ runnerId, workspaceId }` as JSON: the placement `promote` must admit into. It is written when a row becomes `queued` and cleared when it becomes `pending`. The row already carries `workspace_id`; the snapshot exists so promotion does not have to re-read the pin and cannot disagree with the placement the route validated.

## Documentation

`docs/ARCHITECTURE.md`:

- §2.3: one **accepted** run per session; a session may queue more, served FIFO.
- §11.3: replace "Runner có local queue" and "mặc định maxConcurrentRuns = 1" with the negotiated-capacity model, the queue's placement in the outbox, and the promotion triggers.
- §11.4: the server mirrors the runner's workspace lock (§11.4's "Runner có atomic local lock") as an admission rule rather than discovering it through a rejection.
- §17.1: the `202 { queued }` body and the queue endpoint.
- §14.3/§9.4: reconcile-terminal runs release their slot; cancelled queued runs never enter the journal.

## Verification

TDD throughout; each test must be watched failing for the intended reason before the implementation exists.

- **control-db / scheduler**: a second dispatch on a busy session is `{ ok: true, queued: true }` and inserts no `active_runs` row; `promote` admits it by FIFO when released; an ineligible head does not block an eligible successor; workspace conflict is honoured; capacity N admits exactly N; `duplicate_run` sees queued rows; cancel of a queued run retires the row and never touches `active_runs`; a queued first run for a new session writes the pin; two racing dispatches for the same unpinned session agree on one pin; `queue: false` returns the old refusals including `workspace_busy`.
- **control-db / outbox**: `requeue` moves `rejected → queued`, increments `requeue_count` durably, refuses past the ceiling, and `pendingFor` never returns `queued`.
- **control-server / routes**: second prompt on a busy session answers `202 { queued: true }`; the first run's terminal event sends the second `run.start` on the socket without another HTTP call; `GET /queue` returns prompt and time only, owner-scoped; cancel of a queued run returns `202` and the runner never sees it; a queued run whose runner is offline is refused with `503`.
- **control-server / dispatch**: the dispatcher never sends a `queued` command; `onRejectedStart` promotes the next candidate; a transient rejection requeues, a permanent one rejects; past the ceiling the server journals `run.failed { reason: "queue_abandoned" }` and the browser receives it.
- **control-server / gateway + negotiate**: `maxConcurrentRunsOf` reflects `hello.ok`; the literal-1 sites are gone; reconcile that terminalizes a run fires `onRunTerminal` before `onReady`, and the released slot is promotion-ready.
- **runner**: hello advertises the configured value, clamped; two attempts in different workspaces run concurrently, two in the same workspace do not.
- **web**: the strip renders with queue-only state, the History button is gone from the strip but present in the toolbar, the popover lists entries oldest first, `×` calls cancel, and a queued send shows the "queued" confirmation.
- Full gates before reporting done: `bun test`, `bun run typecheck`, `bun run lint`, `git diff --check`, and `cd apps/web && bun run build`.

## Open items left to the builder

- Exact module split for `promote` (scheduler method vs. a small `RunQueue` beside `CommandOutbox`) — behaviour above is the contract.
- How `RunRegistry.apply` reports terminalized run ids (return value vs. event) — the gateway needs the list, not the shape.
- The precise requeue ceiling and its operator-facing message; 50 is a starting point.
- Whether queued runs appear in the runner-capacity indicator on the Runners page; not required by this design.
