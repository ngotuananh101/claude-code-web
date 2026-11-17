# Run Queue and Multi-Run Runners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a runner execute N runs concurrently, and queue a second prompt on a busy session durably instead of refusing it with `409 session_busy`.

**Architecture:** A queued run is a `command_outbox` row in a new `queued` delivery state — minted run/attempt ids, a session pin, a sealed payload, and no `active_runs` row. `Scheduler.dispatch` always enqueues and then tries to admit; a blocked admission leaves the row `queued`. `Scheduler.promote(runnerId, capacity)` admits queued rows FIFO whenever a slot frees (terminal event, rejected start, reconcile interruption, runner `ready`). The per-runner limit is the number negotiated in `hello.ok`, not the literal `1`.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, Vue 3 + shadcn-vue, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-17-run-queue-and-runner-concurrency-design.md`

## Global Constraints

- At most one **accepted** run per session (`active_runs_one_per_session` stays); a session may hold any number of queued runs.
- At most one accepted run per `(runner_id, workspace_id)`, derived by joining `active_runs.session_id` to `sessions.workspace_id`.
- At most `maxConcurrentRuns` accepted runs per runner, where the number is the one negotiated in `hello.ok` (`Math.min(runner declaration, server policy 4)`).
- The dispatcher delivers a `run.start` only while that command holds an `active_runs` row; `queued` rows are invisible to `pendingFor`, and that is how the rule is enforced.
- Queue order is `command_outbox.created_at`; an ineligible head is skipped, never blocking an eligible successor.
- A queued `run.start` never carries a frozen `resumeSessionId`.
- A terminal event, a rejected start, or a reconcile interruption frees the slot and runs promotion immediately — no timer, and no in-memory queue.
- Every retry is bounded: `MAX_REQUEUES = 50`, then a journaled `run.failed { reason: "queue_abandoned", detail }`.
- `409 session_busy` stays reachable only for `queue: false` callers (the scheduled-task tick).
- Queueing absorbs contention, not absence: `runner_offline` / `runner_not_ready` stay `503`.
- Every queued run has a pin from acceptance; the pin write and the `active_runs` insert happen in one synchronous section.
- A cancelled queued run is `rejected` with reason `cancelled` and **nothing is journaled**.
- `packages/control-db` and `packages/runner-db` are the only schema owners; no ad-hoc SQL in control-server or runner.
- Generated shadcn-vue files (`apps/web/src/components/ui/**`, `apps/web/src/lib/utils.ts`, `apps/web/src/styles/index.css`, `apps/web/components.json`) are never edited, linted, or formatted; the protection override stays **last** in `biome.json`.
- No service on the operator's machine is started, stopped, restarted, or reconfigured. Verification is `bun test` and the gates only.
- Technical writing (code, identifiers, comments, commit messages, docs) is English; the conversation is Vietnamese.
- Gates for every task: `export PATH="$HOME/.ponta/bin:$PATH"` first, then `bun test`, `bun run typecheck`, `bun run lint`, `cd apps/web && bun run build`, `git diff --check`.

## Review Focus

These are the failure modes a person will actually meet; each one's test lives in the task named here.

1. **A promotion pass that runs twice admits the same run twice** — the second pass must find nothing, because the row is no longer `queued` and its `active_runs` insert already exists (Task 3).
2. **A queued-send resumes a stale transcript** — the queued payload must omit `resumeSessionId`, so the runner resolves the session's latest conversation at execution (Task 2).
3. **A queued-only session disappears from the sidebar and the dashboard** — a session whose first run never started has no `active_runs` row and no events (Task 4).
4. **A dispatch that contradicts the session's pin queues into the wrong placement** — it must be refused `session_pinned` and write nothing (Task 2).
5. **Cancelling a queued run reaches the runner** — a run that never started has no attempt on any machine; the cancel must retire the outbox row only, and only for its owner (Tasks 3 and 7).

---

### Task 1: Outbox queue states

**Files:**
- Modify: `packages/control-db/src/command-outbox.ts` (whole class)
- Modify: `packages/control-db/src/db.ts:86-155` (outbox DDL, indexes), `db.ts:469` (`addColumnIfMissing`)
- Modify: `packages/control-db/src/index.ts:28-36` (exports)
- Test: `packages/control-db/src/command-outbox.test.ts`, `packages/control-db/src/db.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `type DeliveryState = "queued" | "pending" | "sent" | "accepted" | "rejected"`
  - `type QueueSnapshot = { runnerId: string; workspaceId: string | undefined }` — serialised with `JSON.stringify` as exactly `{"runnerId":"…","workspaceId":"…"}` (the key is present with `null` when there is no workspace, and `requeue`'s fallback rebuild uses the same shape)
  - `EnqueueInput` gains `deliveryState?: "pending" | "queued"` (default `"pending"`) and `queueSnapshot?: QueueSnapshot`
  - `OutboxCommand` gains `requeueCount: number` and `queueSnapshot: QueueSnapshot | undefined`
  - `export const MAX_REQUEUES = 50`
  - `CommandOutbox.markQueued(commandId: string): void` — `pending → queued`, no counter
  - `CommandOutbox.requeue(commandId: string): "requeued" | "ceiling" | "not_rejected"`
  - `CommandOutbox.markPromoted(commandId: string): void` — `queued → pending`, clears `queue_snapshot`
  - `CommandOutbox.queuedFor(runnerId: string): OutboxCommand[]` — `kind='run.start'`, oldest first
  - `CommandOutbox.queuedForSession(sessionId: string): OutboxCommand[]` — same, by session

**Design note (builder's call):** `queue_snapshot` is written at enqueue whenever the caller supplies it, and is not cleared while the row stays `queued` or `pending`; only `markPromoted` clears it. `requeue` rebuilds it from the row's own `runner_id`/`workspace_id` when absent. This replaces the spec's "cleared when it becomes pending": clearing it earlier forces the admission-race flip (Task 2) and `requeue` to reconstruct data the row already holds, with no reader that benefits. That is the one place this plan intentionally departs from the spec's wording — flag it in review if the spec's phrasing was load-bearing.

- [ ] **Step 1: Write the failing tests**

In `command-outbox.test.ts`:

```ts
test("a queued command is never offered for delivery", async () => {
  const { outbox: o } = outbox();
  await o.enqueue({
    ...command,
    deliveryState: "queued",
    queueSnapshot: { runnerId: "runner-a", workspaceId: "workspace-1" },
  });

  expect(o.pendingFor("runner-a")).toEqual([]);
  expect(o.queuedFor("runner-a")).toMatchObject([
    {
      commandId: "cmd-1",
      deliveryState: "queued",
      queueSnapshot: { runnerId: "runner-a", workspaceId: "workspace-1" },
      requeueCount: 0,
    },
  ]);
});

test("a queued command is retired when it expires, like any other", async () => {
  await o.enqueue({
    ...command,
    deliveryState: "queued",
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  });

  expect(o.pendingFor("runner-a")).toEqual([]);
  expect(o.retireExpired("runner-a")).toEqual(["cmd-1"]);
  expect(o.get("cmd-1")).toMatchObject({ deliveryState: "rejected", rejectionReason: "expired" });
});

test("requeue returns a rejected run.start to the queue and counts the attempt", async () => {
  // enqueue with workspaceId "workspace-1", markRejected("cmd-1", "workspace_busy"), then requeue
  expect(o.requeue("cmd-1")).toBe("requeued");
  expect(o.get("cmd-1")).toMatchObject({
    deliveryState: "queued",
    requeueCount: 1,
    rejectionReason: undefined,
    queueSnapshot: { runnerId: "runner-a", workspaceId: "workspace-1" },
  });
});

test("requeue only moves a rejected command", async () => {
  await o.enqueue(command); // pending
  expect(o.requeue("cmd-1")).toBe("not_rejected");
  expect(o.get("cmd-1")).toMatchObject({ deliveryState: "pending", requeueCount: 0 });
});

test("requeue refuses past the ceiling and leaves the row rejected", async () => {
  await o.enqueue(command);
  o.markRejected("cmd-1", "workspace_busy");
  // The spec's ceiling test is `requeue_count > 50`, so 51 is the first refusal.
  db.query("UPDATE command_outbox SET requeue_count = ? WHERE command_id = 'cmd-1'").run(
    MAX_REQUEUES + 1,
  );

  expect(o.requeue("cmd-1")).toBe("ceiling");
  expect(o.get("cmd-1")).toMatchObject({ deliveryState: "rejected", requeueCount: MAX_REQUEUES + 1 });
});

test("promotion flips a queued command to deliverable", async () => {
  await o.enqueue({ ...command, deliveryState: "queued" });
  o.markPromoted("cmd-1");

  expect(o.get("cmd-1")).toMatchObject({ deliveryState: "pending", queueSnapshot: undefined });
  expect(o.pendingFor("runner-a").map((c) => c.commandId)).toEqual(["cmd-1"]);
});

test("queuedForSession lists one session's queue oldest first", async () => {
  await o.enqueue({ ...command, sessionId: "session-1", deliveryState: "queued" }); // created_at earlier
  await o.enqueue({
    ...command,
    commandId: "cmd-2",
    runId: "run-2",
    sessionId: "session-2",
    deliveryState: "queued",
  });
  await o.enqueue({
    ...command,
    commandId: "cmd-3",
    runId: "run-3",
    sessionId: "session-1",
    deliveryState: "queued",
  });
  await o.enqueue({ ...command, commandId: "cmd-4", runId: "run-4", sessionId: "session-1" }); // accepted later

  // created_at is a millisecond clock; force a deterministic order instead of racing it.
  db.query("UPDATE command_outbox SET created_at = 1 WHERE command_id = 'cmd-1'").run();
  db.query("UPDATE command_outbox SET created_at = 3 WHERE command_id = 'cmd-3'").run();

  expect(o.queuedForSession("session-1").map((c) => c.commandId)).toEqual(["cmd-1", "cmd-3"]);
});
```

In `db.test.ts`, add the migration test:

```ts
test("command_outbox carries requeue_count and queue_snapshot", () => {
  const db = new Database(":memory:");
  migrate(db);
  const columns = (db.query("PRAGMA table_info(command_outbox)").all() as Array<{ name: string }>)
    .map((column) => column.name);
  expect(columns).toContain("requeue_count");
  expect(columns).toContain("queue_snapshot");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/control-db/src/command-outbox.test.ts packages/control-db/src/db.test.ts`
Expected: FAIL — `o.queuedFor is not a function`, and the `db.test.ts` column assertion failing.

- [ ] **Step 3: Implement the state**

In `db.ts`, next to the existing `addColumnIfMissing` calls (after `payload_secure`), add the two columns and the partial index exactly as the spec's "Schema and migration" section gives them:

```sql
ALTER TABLE command_outbox ADD COLUMN requeue_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE command_outbox ADD COLUMN queue_snapshot TEXT;
CREATE INDEX IF NOT EXISTS command_outbox_queued
  ON command_outbox (runner_id, created_at) WHERE delivery_state = 'queued';
```

In `command-outbox.ts`:
- `insertPendingSync` writes `delivery_state` from `input.deliveryState ?? "pending"` and `queue_snapshot` as `JSON.stringify(input.queueSnapshot)` or NULL, plus `requeue_count` at its default. Add both to the `Row` type and `toCommand`.
- `pendingFor` narrows its filter to `delivery_state IN ('pending', 'sent')`; `retireExpired` keeps `NOT IN ('accepted','rejected')` so a queued row expires.
- `markSent` and `markAccepted` return early when the row is `queued` (a queued row must never be delivered, so a receipt for one is a protocol error, not a state advance).
- `markQueued`, `markPromoted`, `requeue`, `queuedFor`, `queuedForSession` as declared in Interfaces; `requeue` refuses when the row's `requeue_count > MAX_REQUEUES` (the spec's exact ceiling test — NOT `>=`, so `MAX_REQUEUES` itself still requeues).
- Update the file's header comment: `queued → pending → sent → accepted | rejected`, and one line saying `queued` rows are invisible to `pendingFor` on purpose.

Export `MAX_REQUEUES` and `QueueSnapshot` from `packages/control-db/src/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/control-db/src/command-outbox.test.ts packages/control-db/src/db.test.ts`
Expected: PASS, and the rest of the control-db suite still green (`bun test packages/control-db`).

- [ ] **Step 5: Commit**

```bash
git add packages/control-db/src/command-outbox.ts packages/control-db/src/db.ts \
  packages/control-db/src/index.ts packages/control-db/src/command-outbox.test.ts \
  packages/control-db/src/db.test.ts
git commit -m "feat(control-db): add a queued delivery state and a bounded requeue"
```

---

### Task 2: Queued dispatch

**Files:**
- Modify: `packages/control-db/src/scheduler.ts:116-294` (`DispatchDecision`, `dispatch`)
- Test: `packages/control-db/src/scheduler.test.ts`

**Interfaces:**
- Consumes: Task 1's `deliveryState`, `queueSnapshot`, `markQueued`.
- Produces:
  - `type DispatchOptions = { queue?: boolean }` (default `{ queue: true }`)
  - `DispatchDecision`'s ok variant becomes `{ ok: true; runnerId: string; commandId: string; queued: boolean }`
  - New refusal reasons: `"workspace_busy"`, `"session_pinned"`
  - `async dispatch(request, capacity, options?: DispatchOptions): Promise<DispatchDecision>`

**Dispatch order (fix this, the tests encode it):** sealer gate → `runner_offline` → `runner_not_ready` → `duplicate_run` (also counts non-terminal outbox rows for the run id) → pin contradiction (`session_pinned`) → blockers in the order `session_busy`, `workspace_busy`, `runner_at_capacity` → enqueue → one synchronous section that writes the pin, re-reads it, and inserts `active_runs`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a second dispatch on a busy session is queued instead of refused", async () => {
  const { db, scheduler } = setup();
  await scheduler.dispatch(request, capacity());

  const second = await scheduler.dispatch(
    { ...request, runId: "run-2", attemptId: "attempt-2" },
    capacity(),
  );

  expect(second).toMatchObject({ ok: true, queued: true });
  expect(db.query("SELECT COUNT(*) AS n FROM active_runs").get()).toEqual({ n: 1 });
  expect(
    db.query("SELECT delivery_state, queue_snapshot FROM command_outbox WHERE run_id = 'run-2'").get(),
  ).toEqual({
    delivery_state: "queued",
    queue_snapshot: JSON.stringify({ runnerId: "runner-a", workspaceId: "workspace-1" }),
  });
});

test("queue: false keeps the session_busy refusal", async () => {
  await scheduler.dispatch(request, capacity());
  const second = await scheduler.dispatch(
    { ...request, runId: "run-2", attemptId: "attempt-2" },
    capacity(),
    { queue: false },
  );
  expect(second).toEqual({ ok: false, reason: "session_busy" });
  expect(db.query("SELECT COUNT(*) AS n FROM command_outbox").get()).toEqual({ n: 1 }); // only run-1's row
});

test("a runner at capacity queues the run, and queue: false refuses it", async () => {
  const full = capacity({ activeRuns: 1, maxConcurrentRuns: 1 });
  expect(await scheduler.dispatch(request, full)).toMatchObject({ ok: true, queued: true });
  expect(
    await scheduler.dispatch({ ...request, runId: "run-2", attemptId: "attempt-2" }, full, {
      queue: false,
    }),
  ).toEqual({ ok: false, reason: "runner_at_capacity" });
});

test("another session running on the same workspace is queued", async () => {
  const twoSlots = capacity({ maxConcurrentRuns: 2 });
  expect(await scheduler.dispatch(request, twoSlots)).toMatchObject({ ok: true, queued: false });

  const sibling = { ...request, sessionId: "session-2", runId: "run-2", attemptId: "attempt-2" };
  expect(await scheduler.dispatch(sibling, twoSlots)).toMatchObject({ ok: true, queued: true });
  // A distinct run id, or the persistence check would answer duplicate_run first.
  expect(
    await scheduler.dispatch(
      { ...sibling, runId: "run-3", attemptId: "attempt-3" },
      twoSlots,
      { queue: false },
    ),
  ).toEqual({ ok: false, reason: "workspace_busy" });
});

test("a queued dispatch carries no resumeSessionId, an admitted one keeps it", async () => {
  const withResume = { ...request, resumeSessionId: "sdk-1" };
  await scheduler.dispatch(withResume, capacity()); // run-1 admitted, keeps the field
  await scheduler.dispatch({ ...withResume, runId: "run-2", attemptId: "attempt-2" }, capacity());

  const payloadOf = (runId: string) =>
    JSON.parse(
      (db.query("SELECT payload FROM command_outbox WHERE run_id = ?").get(runId) as { payload: string })
        .payload,
    ) as Record<string, unknown>;

  expect(payloadOf("run-1")["resumeSessionId"]).toBe("sdk-1");
  expect(payloadOf("run-2")).not.toHaveProperty("resumeSessionId");
});

test("a queued first run still pins the session (§invariant 11)", async () => {
  const full = capacity({ activeRuns: 1, maxConcurrentRuns: 1 });
  expect(await scheduler.dispatch(request, full)).toMatchObject({ ok: true, queued: true });
  expect(db.query("SELECT runner_id, workspace_id FROM sessions WHERE id = ?").get("session-1"))
    .toEqual({ runner_id: "runner-a", workspace_id: "workspace-1" });
});

test("a dispatch that contradicts the session's pin is refused, not queued", async () => {
  await scheduler.dispatch(request, capacity()); // pins session-1 → runner-a
  const decision = await scheduler.dispatch(
    { ...request, runId: "run-2", attemptId: "attempt-2" },
    capacity({ runnerId: "runner-b" }),
  );
  expect(decision).toEqual({ ok: false, reason: "session_pinned" });
  expect(db.query("SELECT COUNT(*) AS n FROM command_outbox WHERE run_id = 'run-2'").get()).toEqual({
    n: 0,
  });
});

test("duplicate_run sees a queued run", async () => {
  await scheduler.dispatch(request, capacity()); // run-1 admitted
  await scheduler.dispatch({ ...request, runId: "run-2", attemptId: "attempt-2" }, capacity()); // queued

  const again = await scheduler.dispatch(
    { ...request, runId: "run-2", attemptId: "attempt-2" },
    capacity(),
  );
  expect(again).toEqual({ ok: false, reason: "duplicate_run" });
});
```

Update the two existing race tests at `scheduler.test.ts:330-352` and the rejection cases at `:84-104`: the loser of the `active_runs` insert race is now `{ ok: true, queued: true }`, not `{ ok: false, reason: "session_busy" }`. Keep the `queue: false` variants asserting the old `session_busy`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/control-db/src/scheduler.test.ts`
Expected: FAIL — `queued` is `undefined` on the ok decision, and `session_busy` returned where the test expects `queued: true`.

- [ ] **Step 3: Implement queued dispatch**

In `scheduler.ts`:
- Compute the three blockers synchronously before enqueueing: `this.activeRunFor(request.sessionId)`, `this.#workspaceBusy(capacity.runnerId, request.workspaceId)`, and the capacity comparison already at line 187. Add a private `#workspaceBusy`:
  ```sql
  SELECT 1 FROM active_runs a JOIN sessions s ON s.id = a.session_id
  WHERE a.runner_id = ? AND s.workspace_id = ?
  ```
- With a blocker and `queue === false`, return the blocker's own reason; with `queue !== false`, continue and enqueue with `deliveryState: "queued"`.
- Resolve the pin with `sessionPin(this.#db, request.sessionId)` **before** `await this.#outbox.enqueue(...)`; a pin whose `runnerId` or `workspaceId` differs from the placement is `{ ok: false, reason: "session_pinned" }` and nothing is written.
- Pass `queueSnapshot: { runnerId: capacity.runnerId, workspaceId: request.workspaceId }` and `deliveryState` to `enqueue`; omit `resumeSessionId` from the payload when the row is queued (build the payload after the status is known).
- In the synchronous section after the await: `ensureSessionPin(...)`, re-read the pin, and on contradiction `markRejected(commandId, "session_pinned")` → return the refusal. Insert `active_runs` only when the row was enqueued `pending`; on a `UNIQUE` failure call `markQueued(commandId)` and answer `{ ok: true, queued: true }` instead of rejecting — the race means the session is busy, which is exactly what queuing covers.
- Call `onDispatched` only for an admitted run; a queued row has nothing to deliver.
- Replace the comment at lines 255-263 with the new rule: the pin is resolved before the await, written inside the same synchronous section as the insert, and re-read because `INSERT OR IGNORE` converges two racing dispatches on the first pin.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/control-db/src/scheduler.test.ts`
Expected: PASS, and `bun test packages/control-db` green.

- [ ] **Step 5: Commit**

```bash
git add packages/control-db/src/scheduler.ts packages/control-db/src/scheduler.test.ts
git commit -m "feat(control-db): queue a blocked dispatch instead of refusing it"
```

---

### Task 3: Promotion, release, and queued cancel

**Files:**
- Modify: `packages/control-db/src/scheduler.ts:296-352` (`release`, `cancel`, `activeRunFor`)
- Test: `packages/control-db/src/scheduler.test.ts`

**Interfaces:**
- Consumes: Task 1's `queuedFor`, `markPromoted`, `markRejected`; Task 2's `capacity` shape.
- Produces:
  - `release(runId: string): string | undefined` — the runner whose slot was freed
  - `promote(runnerId: string, capacity: RunnerCapacity): string[]` — admitted run ids, oldest first
  - `async cancel(runId: string, options?: { ownerId?: string })` returning `{ ok: true; queued: false; commandId: string } | { ok: true; queued: true } | { ok: false; reason: "unknown_run" }`

**Promotion is fully synchronous** (every read and write is `bun:sqlite`), so the spec's single-flight flag would guard an interleaving that cannot happen: a nested call is impossible (no await inside the pass), and a second sequential pass finds nothing because the rows it admitted are no longer `queued`. Implement it as one synchronous method and say so in its doc comment — the "promoting twice admits once" test is the executable form of that argument.

- [ ] **Step 1: Write the failing tests**

```ts
test("promote admits a queued run when the session's slot frees", async () => {
  await scheduler.dispatch(request, capacity());                                   // run-1 admitted
  await scheduler.dispatch({ ...request, runId: "run-2", attemptId: "attempt-2" }, capacity()); // queued
  expect(scheduler.release("run-1")).toBe("runner-a");

  expect(scheduler.promote("runner-a", capacity())).toEqual(["run-2"]);
  expect(scheduler.activeRunFor("session-1")).toMatchObject({ runId: "run-2" });
  expect(
    db.query("SELECT delivery_state FROM command_outbox WHERE run_id = 'run-2'").get(),
  ).toEqual({ delivery_state: "pending" });
});

test("promotion is FIFO and skips an ineligible head", async () => {
  const twoSlots = capacity({ maxConcurrentRuns: 2 });
  await scheduler.dispatch(request, twoSlots); // run-1 admitted, session-1
  await scheduler.dispatch(
    { ...request, sessionId: "session-9", workspaceId: "workspace-9", runId: "run-9", attemptId: "attempt-9" },
    twoSlots,
  ); // capacity now full

  await scheduler.dispatch({ ...request, runId: "run-2", attemptId: "attempt-2" }, twoSlots); // queued, session-1
  await scheduler.dispatch(
    { ...request, sessionId: "session-2", workspaceId: "workspace-2", runId: "run-3", attemptId: "attempt-3" },
    twoSlots,
  ); // queued, session-2

  // run-2 is older, but session-1 is still running run-1, so a freed slot must go to run-3.
  scheduler.release("run-9");
  expect(scheduler.promote("runner-a", twoSlots)).toEqual(["run-3"]);

  scheduler.release("run-1");
  expect(scheduler.promote("runner-a", twoSlots)).toEqual(["run-2"]);
});

test("promotion admits only as many runs as the freed slots allow", async () => {
  const threeSlots = capacity({ maxConcurrentRuns: 3 });
  await scheduler.dispatch(request, threeSlots); // session-1 / workspace-1, admitted
  await scheduler.dispatch(
    { ...request, sessionId: "session-2", workspaceId: "workspace-2", runId: "run-2", attemptId: "attempt-2" },
    threeSlots,
  ); // admitted
  for (const [index, session] of ["session-3", "session-4", "session-5"].entries()) {
    await scheduler.dispatch(
      {
        ...request,
        sessionId: session,
        workspaceId: `workspace-${index + 3}`,
        runId: `run-${index + 3}`,
        attemptId: `attempt-${index + 3}`,
      },
      threeSlots,
    );
  } // three queued, capacity full at 2 of 3

  scheduler.release("run-1"); // one slot free, three candidates
  expect(scheduler.promote("runner-a", threeSlots)).toEqual(["run-3"]); // exactly one, not three
});

test("promotion skips a run whose workspace is busy", async () => {
  // Sessions 1 and 2 both pinned to workspace-1, capacity 2.
  await scheduler.dispatch(request, capacity({ maxConcurrentRuns: 2 })); // run-1 admitted, workspace-1
  await scheduler.dispatch(
    { ...request, sessionId: "session-2", runId: "run-2", attemptId: "attempt-2" },
    capacity({ maxConcurrentRuns: 2 }),
  ); // queued: another session, same workspace

  expect(scheduler.promote("runner-a", capacity({ maxConcurrentRuns: 2 }))).toEqual([]);
  expect(db.query("SELECT COUNT(*) AS n FROM active_runs").get()).toEqual({ n: 1 });
});

test("promotion admits nothing while the runner is not ready", () => {
  expect(scheduler.promote("runner-a", capacity({ state: "offline" }))).toEqual([]);
  expect(scheduler.promote("runner-a", capacity({ state: "connected" }))).toEqual([]);
});

test("promoting twice admits a queued run once", async () => {
  await scheduler.dispatch(request, capacity()); // run-1 admitted
  await scheduler.dispatch({ ...request, runId: "run-2", attemptId: "attempt-2" }, capacity()); // queued
  scheduler.release("run-1");

  expect(scheduler.promote("runner-a", capacity())).toEqual(["run-2"]);
  expect(scheduler.promote("runner-a", capacity())).toEqual([]);
  expect(db.query("SELECT COUNT(*) AS n FROM active_runs WHERE run_id = 'run-2'").get()).toEqual({
    n: 1,
  });
});

test("a fresh scheduler promotes durable queue state after a restart", async () => {
  await scheduler.dispatch(request, capacity());
  await scheduler.dispatch({ ...request, runId: "run-2", attemptId: "attempt-2" }, capacity());
  scheduler.release("run-1");

  const restarted = new Scheduler(db, options); // same database, new in-memory state
  expect(restarted.promote("runner-a", capacity())).toEqual(["run-2"]);
});

test("cancelling a queued run retires it without touching the runner", async () => {
  await scheduler.dispatch(request, capacity()); // run-1 admitted
  await scheduler.dispatch({ ...request, runId: "run-2", attemptId: "attempt-2" }, capacity()); // queued

  expect(await scheduler.cancel("run-2")).toEqual({ ok: true, queued: true });
  expect(
    db.query("SELECT delivery_state, rejection_reason FROM command_outbox WHERE run_id = 'run-2'").get(),
  ).toEqual({ delivery_state: "rejected", rejection_reason: "cancelled" });
  expect(db.query("SELECT COUNT(*) AS n FROM command_outbox WHERE kind = 'run.cancel'").get()).toEqual({
    n: 0,
  });
  expect(db.query("SELECT COUNT(*) AS n FROM active_runs").get()).toEqual({ n: 1 });
});

test("another owner cannot cancel this run", async () => {
  await scheduler.dispatch(request, capacity());
  await scheduler.dispatch({ ...request, runId: "run-2", attemptId: "attempt-2" }, capacity());

  expect(await scheduler.cancel("run-2", { ownerId: "user-2" })).toEqual({
    ok: false,
    reason: "unknown_run",
  });
  expect(await scheduler.cancel("run-2", { ownerId: "user-1" })).toEqual({ ok: true, queued: true });
});

test("cancelling an active run is unchanged and carries its command id", async () => {
  await scheduler.dispatch(request, capacity());
  const decision = await scheduler.cancel("run-1");
  expect(decision).toMatchObject({ ok: true, queued: false });
  expect(decision.ok && decision.commandId).toMatch(/^cmd_/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/control-db/src/scheduler.test.ts`
Expected: FAIL — `scheduler.promote is not a function`, `release` returning `undefined`, `cancel` of a queued run answering `unknown_run`.

- [ ] **Step 3: Implement**

- `release` reads `runner_id` for the run id before the `DELETE` and returns it (undefined when no row).
- `promote(runnerId, capacity)`: return `[]` unless `capacity.state === "ready"`; read `maxConcurrentRuns`; count accepted runs with `SELECT COUNT(*) FROM active_runs WHERE runner_id = ?`; return `[]` when the count already meets the limit. Then loop `queuedFor(runnerId)` oldest first, and for each row read its `queue_snapshot` (falling back to the row's `workspace_id`/`runner_id` when the column is NULL — rows queued before this migration), skip it when its session has an accepted run or its `(runner, workspace)` does, and otherwise `db.transaction(() => { INSERT INTO active_runs …; this.#outbox.markPromoted(row.commandId); })()`. A `UNIQUE` throw inside the transaction rolls the flip back — catch it, skip the row, continue. Stop at the limit. When at least one run was admitted, call `this.#options.onDispatched(runnerId)` once before returning — that is the existing seam to `dispatcher.drain`, and it is what keeps delivery inside the same call (spec step 5). Return the admitted run ids in order.
- Owner scoping in `cancel`: when `options.ownerId` is given, compare it against `sessionPin(this.#db, sessionId).ownerId` — `sessionPin` already carries the owner, and every queued run has a pin by invariant 11. A mismatch, or a missing pin, is `unknown_run` (no existence leak), exactly as the route's `pin.ownerId !== authorized.userId` check answers 404.
- `cancel` on a queued run: `markRejected(commandId, "cancelled")`, no `run.cancel` command, no `onDispatched`, answer `{ ok: true, queued: true }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/control-db/src/scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/control-db/src/scheduler.ts packages/control-db/src/scheduler.test.ts
git commit -m "feat(control-db): promote queued runs and cancel them without the runner"
```

---

### Task 4: Queue read models

**Files:**
- Create: `packages/control-db/src/run-queue.ts`
- Create: `packages/control-db/src/run-queue.test.ts`
- Modify: `packages/control-db/src/replay.ts:202-211` (`dispatched` union)
- Modify: `packages/control-db/src/stats.ts:82-107` (session/run counts)
- Modify: `packages/control-db/src/index.ts` (export `queuedRunsForSession`, `QueuedRunSummary`)
- Test: `packages/control-db/src/replay.test.ts`, `packages/control-db/src/stats.test.ts`

**Interfaces:**
- Consumes: Task 1's `queued` state.
- Produces: `type QueuedRunSummary = { runId: string; attemptId: string; prompt: string; enqueuedAt: number }` and `queuedRunsForSession(db: Database, sessionId: string): QueuedRunSummary[]` — display fields only, oldest first, never the profile or workspace path.

- [ ] **Step 1: Write the failing tests**

```ts
// run-queue.test.ts
test("lists one session's queued runs with display fields only, oldest first", async () => {
  // two queued run.start rows for session-1 (created_at forced to 2 and 1), one accepted
  expect(queuedRunsForSession(db, "session-1")).toEqual([
    { runId: "run-a", attemptId: "attempt-a", prompt: "first", enqueuedAt: 1 },
    { runId: "run-b", attemptId: "attempt-b", prompt: "second", enqueuedAt: 2 },
  ]);
});

// replay.test.ts
test("a session whose only run is queued appears in the sidebar", () => {
  // runners + sessions rows, plus a queued run.start with no active_runs row and no events
  expect(listSessions(db, "user-1").map((s) => s.sessionId)).toEqual(["session-queued"]);
  expect(listSessions(db, "user-1")[0]).toMatchObject({ live: true, runnerId: "runner-a" });
});

// stats.test.ts
test("a queued run counts in usage stats", () => {
  // same fixture as the sidebar test
  expect(usageStats(db, "user-1").counts).toMatchObject({ sessions: 1, runs: 1 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/control-db/src/run-queue.test.ts packages/control-db/src/replay.test.ts packages/control-db/src/stats.test.ts`
Expected: FAIL — `queuedRunsForSession` does not resolve; the sidebar and counts omit the queued session.

- [ ] **Step 3: Implement**

- `run-queue.ts`: `SELECT command_id, run_id, attempt_id, payload, created_at FROM command_outbox WHERE session_id = ? AND kind = 'run.start' AND delivery_state = 'queued' ORDER BY created_at ASC, command_id ASC`; parse `prompt` out of the stored payload JSON (a non-string or missing prompt maps to `""`). No join, so a row for a session whose pin is somehow gone is still listable.
- `replay.ts`: extend the `dispatched` union with `command_outbox` rows for `kind = 'run.start'` in `('queued','pending','sent')`, joined to `runners` for `owner_id` and `LEFT JOIN sessions` for title/workspace/runner exactly like the `active_runs` arm; `dispatched_at` is `created_at`.
- `stats.ts`: add the same `command_outbox` arm to both `UNION`s.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/control-db`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/control-db/src/run-queue.ts packages/control-db/src/run-queue.test.ts \
  packages/control-db/src/replay.ts packages/control-db/src/replay.test.ts \
  packages/control-db/src/stats.ts packages/control-db/src/stats.test.ts \
  packages/control-db/src/index.ts
git commit -m "feat(control-db): expose queued runs to the sidebar, stats and the queue endpoint"
```

---

### Task 5: Runner concurrency advertisement

**Files:**
- Modify: `apps/runner/src/daemon.ts:140-190` (`helloFrame`), `:196-300` (`DaemonOptions`), `:455-470` (hello thunk)
- Modify: `apps/runner/src/bootstrap/main.ts:322-344` (composition)
- Test: `apps/runner/src/daemon.test.ts`, `apps/runner/src/execution/run-controller.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `helloFrame` input gains `maxConcurrentRuns?: number` (default `1`); `DaemonOptions.maxConcurrentRuns?: number`; exported `resolveMaxConcurrentRuns(value: string | undefined): number` from `daemon.ts` (positive integer or `1`).

- [ ] **Step 1: Write the failing tests**

```ts
test("the hello advertises the configured concurrency", () => {
  expect(helloFrame({ ...helloInput, maxConcurrentRuns: 3 })["maxConcurrentRuns"]).toBe(3);
});

test("the hello advertises one when nothing was configured", () => {
  expect(helloFrame(helloInput)["maxConcurrentRuns"]).toBe(1);
});

test("the env override parses to a positive integer, otherwise one", () => {
  expect(resolveMaxConcurrentRuns("4")).toBe(4);
  for (const bad of [undefined, "", "0", "-2", "2.5", "many"]) {
    expect(resolveMaxConcurrentRuns(bad)).toBe(1);
  }
});

// run-controller.test.ts
test("two attempts in different workspaces run concurrently", async () => {
  // two holdable streams, workspaces workspace-1 and workspace-2
  // both receipts arrive accepted before either stream is released
  // then release both; both attempts end finished and both locks are gone
});

test("two attempts in the same workspace do not run concurrently", async () => {
  // second start on workspace-1 is receipted workspace_busy while the first holds it
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/runner/src/daemon.test.ts apps/runner/src/execution/run-controller.test.ts`
Expected: FAIL for the first three (`resolveMaxConcurrentRuns` missing, `maxConcurrentRuns` always 1); the two concurrency tests may already pass — if they do, keep them as regression tests and say so in the commit body.

- [ ] **Step 3: Implement**

- `helloFrame`: `maxConcurrentRuns: input.maxConcurrentRuns ?? 1`, with a comment that the server clamps it by policy (4) and that the default keeps an existing installation at today's behaviour.
- `resolveMaxConcurrentRuns(value)`: `/^\d+$/` and `> 0`, else `1`.
- `DaemonOptions.maxConcurrentRuns?: number`, passed through in the hello thunk next to `models`.
- `bootstrap/main.ts`: read `process.env["CC_WEB_RUNNER_MAX_CONCURRENT_RUNS"]`, pass `resolveMaxConcurrentRuns(...)` into `startDaemon`, and warn on stderr once when the value is present but unusable.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test apps/runner`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/daemon.ts apps/runner/src/daemon.test.ts \
  apps/runner/src/bootstrap/main.ts apps/runner/src/execution/run-controller.test.ts
git commit -m "feat(runner): advertise a configurable concurrent-run limit"
```

---

### Task 6: Gateway capacity and reconcile release

**Files:**
- Modify: `packages/protocol/src/run-registry.ts:136-176` (`apply`)
- Modify: `packages/protocol/src/run-registry.test.ts`
- Modify: `apps/control-server/src/websocket/runner/runner-gateway.ts:86-102` (`Connection`), `:127` (`onReady`), `:497-505` (hello store), `:560-585` (reconcile)
- Test: `apps/control-server/src/websocket/runner/runner-gateway.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `RunRegistry.apply(action): string[]` — the run ids this action moved to a terminal observation
  - `RunnerGateway.maxConcurrentRunsOf(runnerId: string): number | undefined`
  - `RunnerGatewayOptions.onRunTerminal?: (runnerId: string, runId: string) => void`, fired once per terminalized run **before** `connection.state = "ready"` and before `onReady`

- [ ] **Step 1: Write the failing tests**

```ts
// run-registry.test.ts
test("mark_interrupted reports the run it terminalized", () => {
  expect(runs.apply({ kind: "mark_interrupted", runId: "run-1", attemptId: "attempt-1" })).toEqual([
    "run-1",
  ]);
});
test("an action for a non-current attempt reports nothing", () => {
  expect(runs.apply({ kind: "mark_interrupted", runId: "run-1", attemptId: "attempt-9" })).toEqual([]);
});
test("a terminal run is not reported twice, and quarantine reports nothing", () => {
  // mark_interrupted then mark_interrupted again → second returns []
  // quarantine → []
});

// runner-gateway.test.ts
test("maxConcurrentRunsOf reflects the negotiated hello", () => {
  // hello maxConcurrentRuns 3, policy 4 → 3
  expect(gateway.maxConcurrentRunsOf("runner-a")).toBe(3);
});
test("the negotiated capacity is clamped by policy", () => {
  // hello maxConcurrentRuns 9 → 4
});
test("maxConcurrentRunsOf is undefined when nothing is live", () => {
  expect(gateway.maxConcurrentRunsOf("runner-a")).toBeUndefined();
});
test("a reconcile that terminalizes a run reports it before the runner is ready", () => {
  // RunRegistry holding run-1/attempt-1; reconnect with an empty inventory so reconcile
  // emits mark_interrupted; onRunTerminal records state seen at call time
  expect(events).toEqual([{ kind: "terminal", runId: "run-1", stateAtCall: "connected" }]);
  expect(readyCalls).toEqual(["runner-a"]);
  expect(gateway.stateOf("runner-a")).toBe("ready");
});
test("a reconcile that terminalizes nothing fires no hook", () => {});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/protocol/src/run-registry.test.ts apps/control-server/src/websocket/runner/runner-gateway.test.ts`
Expected: FAIL — `apply` returns `undefined`, `maxConcurrentRunsOf is not a function`, no hook is called.

- [ ] **Step 3: Implement**

- `RunRegistry.apply` returns `[]` from every branch except the two that set a terminal `observedState` (`adopt_terminal`, `mark_interrupted`), which return `[action.runId]`; a second terminal observation and a non-current attempt return `[]`.
- `Connection` gains `maxConcurrentRuns: number`; `#handleHello` stores `result.negotiation.policy.maxConcurrentRuns`; `maxConcurrentRunsOf` returns `this.#live.get(runnerId)?.maxConcurrentRuns`, deliberately `undefined` after a close like `capabilitiesOf`.
- `GatewayOptions` gains `onRunTerminal`; in `#handleReconcile`, collect the ids each `this.#runs.apply(action)` returns and fire the hook for each one inside the action loop, before the `connection.state = "ready"` line.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/protocol apps/control-server/src/websocket/runner`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/run-registry.ts packages/protocol/src/run-registry.test.ts \
  apps/control-server/src/websocket/runner/runner-gateway.ts \
  apps/control-server/src/websocket/runner/runner-gateway.test.ts
git commit -m "feat(control-server): expose negotiated capacity and report reconcile terminals"
```

---

### Task 7: HTTP surface

**Files:**
- Modify: `apps/control-server/src/routes/runs-routes.ts:311-320` (drop the early `session_busy`), `:414-446` (capacity + 202 body + mapping), `:447-489` (`handleCancelRun`)
- Modify: `apps/control-server/src/server.ts:768-790` (route table) and the sessions GET area (`:611-630`)
- Test: `apps/control-server/src/routes/runs-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 4, 6 — `dispatch(request, capacity, options)`, `cancel(runId, { ownerId })`, `queuedRunsForSession`, `runnerGateway.maxConcurrentRunsOf`.
- Produces: `202 { runId, attemptId, sessionId, runnerId, queued: boolean }`; `GET /api/sessions/:sessionId/queue → { runs: QueuedRunSummary[] }`; `POST /api/runs/:runId/cancel → 202 { runId, queued, commandId? }`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a second prompt on a busy session answers 202 with queued: true", async () => {
  const first = await post(`${url}/api/sessions/session-1/runs`, { prompt: "one" }, cookie);
  const second = await post(`${url}/api/sessions/session-1/runs`, { prompt: "two" }, cookie);
  expect(first.status).toBe(202);
  expect(second.status).toBe(202);
  expect(await second.json()).toMatchObject({ queued: true });
  expect(await first.json()).toMatchObject({ queued: false });
});

test("the queued run starts once the first run's terminal event arrives, with no second HTTP call", async () => {
  // connect a runner, send two prompts, push run.finished for the first run,
  // then expect a run.start envelope for the second run on the socket
});

test("GET /api/sessions/:id/queue returns prompt and enqueue time only", async () => {
  // body has exactly { runs: [{ runId, attemptId, prompt, enqueuedAt }] }
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(Object.keys(body.runs[0]).sort()).toEqual(["attemptId", "enqueuedAt", "prompt", "runId"]);
});

test("the queue endpoint is owner-scoped", async () => {
  // another user's cookie → 404, never the queue
});

test("cancelling a queued run answers 202 and the runner never receives it", async () => {
  // queued: true in the body; no run.cancel command on the socket
});

test("a queued prompt whose pinned runner went offline is refused 503", async () => {
  // pin the session, close the runner, POST again → 503 runner_offline
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/control-server/src/routes/runs-routes.test.ts`
Expected: FAIL — the second prompt answers 409; `/api/sessions/x/queue` is 404.

- [ ] **Step 3: Implement**

- `runs-routes.ts`: delete the early `scheduler.activeRunFor(sessionId)` block (the scheduler now decides, and `queue` is on by default). Pass `maxConcurrentRuns: runnerGateway.maxConcurrentRunsOf(ready) ?? 1` into `capacityFor`. Include `queued: decision.queued` in the 202 body. Status mapping: `session_busy | duplicate_run | session_pinned → 409`; everything else `503`.
- `handleCancelRun`: pass `{ ownerId: authorized.userId }`; answer `202 { runId, queued, ...(commandId === undefined ? {} : { commandId }) }`.
- New `handleSessionQueue(request, options, allowedOrigins, browserGateway, sessionId)` in `runs-routes.ts`: authorize, resolve `sessionPin`; a missing pin or another owner is `404 not found`; else `{ runs: queuedRunsForSession(options.db, sessionId) }` with `Cache-Control: no-store`.
- `server.ts`: register `GET /^\/api\/sessions\/([^/]+)\/queue$/` next to `runsMatch`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test apps/control-server/src/routes/runs-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-server/src/routes/runs-routes.ts apps/control-server/src/server.ts \
  apps/control-server/src/routes/runs-routes.test.ts
git commit -m "feat(control-server): answer 202 queued and serve the session's run queue"
```

---

### Task 8: Promotion wiring and bounded requeue

**Files:**
- Create: `apps/control-server/src/dispatch/requeue.ts`
- Create: `apps/control-server/src/dispatch/requeue.test.ts`
- Modify: `apps/control-server/src/server.ts:245` (`onReady`), `:362-369` (terminal release), `:432-442` (`onRejectedStart`), `:456-459` (scheduler construction, `onRunTerminal`)
- Modify: `apps/control-server/src/scheduling/schedule-loop.ts:120-140`
- Test: `apps/control-server/src/scheduling/schedule-loop.test.ts`, `apps/control-server/src/dispatch/end-to-end.test.ts`

**Interfaces:**
- Consumes: Tasks 1-7.
- Produces: `handleRejectedStart(input: { db, outbox, scheduler, publish?, runId, commandId, reason, now? }): "requeued" | "abandoned" | "rejected"` in `dispatch/requeue.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// requeue.test.ts
test("a transient rejection returns the command to the queue and promotes", () => {
  // reason "workspace_busy": the row is queued again, requeueCount 1,
  // and a queued successor on the same runner becomes admitted
});
test("a permanent rejection retires the command and journals nothing", () => {
  // reason "unknown_workspace": delivery_state rejected, no run_events row
});
test("past the ceiling the server journals run.failed queue_abandoned and broadcasts it", () => {
  // requeue_count at MAX_REQUEUES, reason "draining"
  // one run_events row: type "run.failed", payload { reason: "queue_abandoned", detail: "draining" }
  // publish called once with that event and its sessionId
});

// schedule-loop.test.ts
test("the schedule tick queues nothing and keeps a busy row due", () => {
  // session busy → decision ok false, row still due, zero queued outbox rows
});

// end-to-end.test.ts
test("a queued run is delivered over the socket after the first run's terminal event", async () => {
  // two dispatches on one session, push run.finished for the first,
  // observe the second run.start envelope and its accepted receipt
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/control-server/src/dispatch/requeue.test.ts apps/control-server/src/scheduling/schedule-loop.test.ts apps/control-server/src/dispatch/end-to-end.test.ts`
Expected: FAIL — the module does not exist; the tick still queues (the scheduler defaults to queueing) so the "zero queued rows" assertion fails.

- [ ] **Step 3: Implement**

- `requeue.ts`: classify `workspace_busy` and `draining` as transient. Transient and under the ceiling: `scheduler.release(runId)`, `outbox.requeue(commandId)`, `scheduler.promote(runnerId, capacity)`. At the ceiling: `scheduler.release(runId)`, `appendServerEvent(db, { runnerId, sessionId, runId, attemptId, type: "run.failed", payload: { reason: "queue_abandoned", detail } })` — read the row's `runnerId`/`sessionId`/`attemptId` from the outbox before rejecting it — then `markRejected(commandId, "queue_abandoned")` and `publish` the stored event exactly like `approvals/abandon.ts` does (skip the publish when `status !== "stored"`). Permanent: `release`, keep `reopenRejectedSchedule`, return `"rejected"`. The caller passes a `capacityOf(runnerId)` closure because the function cannot see the gateway.
- `server.ts`: a local `capacityOf(runnerId)` helper builds `{ runnerId, state: runnerGateway.stateOf(runnerId), maxConcurrentRuns: runnerGateway.maxConcurrentRunsOf(runnerId) ?? 1, activeRuns: 0 }` through `scheduler.capacityFor`. Then a local `promote(runnerId)` is just `scheduler.promote(runnerId, capacityOf(runnerId))` — `Scheduler.promote` already calls `onDispatched`, which is the existing `dispatcher?.drain` seam, so there is no second drain to add. Wire `onReady: (id) => promote(id)`, the terminal-event branch to `const freed = scheduler.release(event.runId); if (freed !== undefined) promote(freed);`, `onRunTerminal: (_runnerId, runId) => { const freed = scheduler.release(runId); if (freed !== undefined) promote(freed); }`, and `onRejectedStart` to `handleRejectedStart(...)` plus the existing `reopenRejectedSchedule` on the permanent path.
- `schedule-loop.ts`: pass `{ queue: false }` and `maxConcurrentRuns: runnerGateway.maxConcurrentRunsOf(pin.runnerId) ?? 1`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test apps/control-server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-server/src/dispatch/requeue.ts apps/control-server/src/dispatch/requeue.test.ts \
  apps/control-server/src/server.ts apps/control-server/src/scheduling/schedule-loop.ts \
  apps/control-server/src/scheduling/schedule-loop.test.ts \
  apps/control-server/src/dispatch/end-to-end.test.ts
git commit -m "feat(control-server): promote on every slot release and bound the requeue"
```

---

### Task 9: Web queue service

**Files:**
- Create: `apps/web/src/services/queue-api.ts`
- Create: `apps/web/src/services/queue-api.test.ts`
- Create: `apps/web/src/features/composer/run-queue.ts`
- Create: `apps/web/src/features/composer/run-queue.test.ts`
- Modify: `apps/web/src/services/runs-api.ts` (`StartRunResult`)
- Test: `apps/web/src/services/runs-api.test.ts`

**Interfaces:**
- Consumes: the Task 7 wire shapes.
- Produces:
  - `type QueuedRun = { runId: string; attemptId: string; prompt: string; enqueuedAt: number }`
  - `fetchSessionQueue(sessionId: string): Promise<{ ok: true; runs: QueuedRun[] } | { ok: false; reason: "unauthorized" | "error" }>`
  - `pruneQueuedRuns(runs: QueuedRun[], events: Array<{ type: string; runId: string }>): QueuedRun[]`
  - `StartRunResult`'s ok variant gains `queued: boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// queue-api.test.ts
test("parses the queue and drops rows that are not display-shaped", ...);
// a malformed entry (missing runId, non-numeric enqueuedAt) is skipped, not rendered as blank
test("answers unauthorized on 401 and error on anything else", ...);

// run-queue.test.ts
test("pruning drops a run once its run.started arrives", () => {
  expect(pruneQueuedRuns([a, b], [{ type: "run.started", runId: "run-a" }])).toEqual([b]);
});
test("other event types leave the queue alone", ...);

// runs-api.test.ts
test("a 202 that says queued reports queued: true", async () => {
  // capture(202, { runId, attemptId, sessionId, queued: true })
  expect(result).toEqual({ ok: true, runId: "run-1", attemptId: "attempt-1", sessionId: "session-1", queued: true });
});
test("a 202 without the flag reports queued: false", ...);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/web/src/services/queue-api.test.ts apps/web/src/features/composer/run-queue.test.ts apps/web/src/services/runs-api.test.ts`
Expected: FAIL — modules missing, `queued` undefined.

- [ ] **Step 3: Implement**

- `queue-api.ts`: `authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/queue`)`, 401 → `unauthorized`, non-2xx → `error`, parse `{ runs }` and keep only entries whose `runId`/`attemptId`/`prompt` are strings and `enqueuedAt` is a finite number. Never throws.
- `run-queue.ts`: `pruneQueuedRuns` builds a `Set` of `runId`s from `run.started` events and filters.
- `runs-api.ts`: read `body.queued === true` into the ok result; the type gains the field.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test apps/web/src`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/queue-api.ts apps/web/src/services/queue-api.test.ts \
  apps/web/src/features/composer/run-queue.ts apps/web/src/features/composer/run-queue.test.ts \
  apps/web/src/services/runs-api.ts apps/web/src/services/runs-api.test.ts
git commit -m "feat(web): read the session queue and the queued flag"
```

---

### Task 10: Composer queue strip

**Files:**
- Modify: `apps/web/src/components/Composer.vue:106-118` (props/emits), `:818-854` (strip), `:600-670` (`send`), `:975-991` (toolbar — unchanged, verify)
- Modify: `apps/web/src/views/SessionView.vue:165-200` (queue state), `:296-312` (`onStarted`), `:415-423` (Composer wiring)
- Modify: `apps/web/src/lib/i18n/types.ts`, `apps/web/src/lib/i18n/locales/en.ts`, `apps/web/src/lib/i18n/locales/vi.ts`
- Test: none new — the logic lives in Task 9's tested modules; this task is verified by `bun run typecheck` (including `typecheck:vue`), `bun run lint`, and the web build.

**Interfaces:**
- Consumes: Task 9's `QueuedRun`, `fetchSessionQueue`, `pruneQueuedRuns`, `cancelRun`, and `StartRunResult.queued`.
- Produces: `Composer` props gain `queuedRuns?: QueuedRun[]`, emits gain `cancelQueued: [runId: string]`; `SessionView` owns the queue state and its refresh.

**New i18n keys** (add to `types.ts`, `en.ts`, `vi.ts` under `composer`): `queuedWaiting` (`"Waiting ({count})"` / `"Đang chờ ({count})"`), `queuedTitle` (`"Waiting · starts when the current turn ends"` / `"Đang chờ · chạy khi lượt hiện tại xong"`), `queuedEmpty`, `queuedCancelAria`, `promptQueued` (`"Prompt queued"` / `"Đã xếp prompt vào hàng đợi"`), `errorQueueCancelFailed`.

- [ ] **Step 1: Render the strip**

- Replace the strip's condition with `subagentCounts.total > 0 || queuedRuns.length > 0`, and delete the History button block at `Composer.vue:844-853` (the toolbar's own History button at `:975-991` stays unchanged).
- The left button keeps its current shape and only renders when `subagentCounts.total > 0`.
- The right side is a `Popover` (`Popover`, `PopoverTrigger`, `PopoverContent` from `@/components/ui/popover` — all three are exported from that barrel), side `top`, `align="end"`, trigger labelled `t("composer.queuedWaiting", { count: queuedRuns.length })`. The content is hand-styled to match `SlashCommandMenu.vue`: `w-[calc(100vw-2rem)] max-w-[26rem] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground p-1 shadow-2xl`, `role="listbox"`, `:aria-label="t('composer.queuedTitle')"`. `ScrollArea` must be **imported** in `Composer.vue` (it is not today) from `@/components/ui/scroll-area`, with the same `[&>[data-slot=scroll-area-viewport]]:max-h-[min(17rem,40dvh)]` classes. Each row: the prompt as one truncated line with `:title="run.prompt"`, `relativeTime(run.enqueuedAt)` underneath (from `@/lib/relative-time`, which takes milliseconds — `command_outbox.created_at` is a `Date.now()` value), and a `×` button with `:aria-label="t('composer.queuedCancelAria')"` emitting `cancelQueued` with `run.runId`. Empty list → a single `queuedEmpty` line.
- In `send()`, `if (result.ok)` gains: when `result.queued` is true, `toast.success(t("composer.promptQueued"))` instead of nothing, and still clear the prompt, emit `started`, and return. Leave the `session_busy` branch in place — it is now unreachable from this route but the API still names it.

- [ ] **Step 2: Wire the view**

- `SessionView.vue`: `const queuedRuns = ref<QueuedRun[]>([])`; `async function refreshQueue(sessionId: string | null)` that clears when null and otherwise assigns `fetchSessionQueue(...).ok ? runs : []`; call it from the route-session watcher and from `onStarted`; watch `journalEvents` and assign `pruneQueuedRuns(queuedRuns.value, journalEvents.value)`. A `cancelQueuedQueuedRun(runId)` handler calls `cancelRun(runId)`, refreshes the queue, and toasts `t("composer.errorQueueCancelFailed")` on `error`/`unauthorized`.
- Pass `:queued-runs="queuedRuns"` and `@cancel-queued="cancelQueuedRun"` at `SessionView.vue:418-423`.

- [ ] **Step 3: Verify**

Run: `bun run typecheck` (this is the only gate that reads `.vue`), `bun run lint`, `cd apps/web && bun run build`.
Expected: all exit 0; no diagnostics under `components/ui/**`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/Composer.vue apps/web/src/views/SessionView.vue \
  apps/web/src/lib/i18n/types.ts apps/web/src/lib/i18n/locales/en.ts \
  apps/web/src/lib/i18n/locales/vi.ts
git commit -m "feat(web): show the waiting queue where the subagent strip's history button was"
```

---

### Task 11: Documentation and full gates

**Files:**
- Modify: `docs/ARCHITECTURE.md` §2.3, §11.3, §11.4, §14.3, §9.4, §17.1
- Modify: `CLAUDE.md` (runner env list)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing executable.

- [ ] **Step 1: Update `docs/ARCHITECTURE.md`**

- §2.3: one **accepted** run per session; more may be queued and are served FIFO.
- §11.3: replace "Runner có local queue" and "mặc định `maxConcurrentRuns = 1`" with the negotiated-capacity model (runner declaration, clamped by policy 4), the queue living in `command_outbox`, and the promotion triggers (terminal event, rejected start, reconcile interruption, `ready`).
- §11.4: the server mirrors the runner's workspace lock as an admission rule (`(runner_id, workspace_id)`), so a conflict is queued rather than discovered as a `workspace_busy` rejection.
- §14.3 / §9.4: reconcile-terminal runs release their slot and promote; a cancelled queued run never enters the journal.
- §17.1: `202 { queued }`, `GET /api/sessions/:id/queue`, and cancel of a queued run.

- [ ] **Step 2: Update `CLAUDE.md`**

Add `CC_WEB_RUNNER_MAX_CONCURRENT_RUNS` (default `1`, clamped by the server policy `4`) to the runner connector section, next to `CC_WEB_APPROVAL_TIMEOUT_MS`.

- [ ] **Step 3: Run every gate fresh**

Run, each from the repo root unless noted:

```bash
export PATH="$HOME/.ponta/bin:$PATH"
bun test
bun run typecheck
bun run lint
git diff --check
cd apps/web && bun run build
```

Expected: all exit 0, `bun test` reports no failures. Any failure — including one in a file this plan did not touch — is reported by name.

- [ ] **Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md CLAUDE.md
git commit -m "docs: the run queue, negotiated concurrency, and the queued turn"
```
