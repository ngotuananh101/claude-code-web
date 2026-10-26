# Backpressure and Spool Limits Implementation Plan (M5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the event transport bounded in bytes and in spool depth, treat a dropped socket write as a failure rather than a delivery, and give the runner's offline spool explicit warning/critical thresholds whose critical policy stops the run instead of losing events.

**Architecture:** Four seams, each independently testable. `packages/runner-db` gets a LIMIT on the outbox read and a spool-depth aggregate. `apps/runner/src/connection/event-pump.ts` grows a byte ceiling, a retry timer for refused sends, and the threshold checks. `apps/control-server/src/websocket/browser/browser-gateway.ts` reads Bun's `send()` return value and disconnects a socket that reports a dropped frame. Both `Bun.serve` calls get an explicit `maxPayloadLength`.

**Tech Stack:** Bun 1.4.3 (runtime + test), TypeScript 7.0.2, `bun:sqlite`, Bun WebSockets, Biome, Vue 3 (untouched this milestone).

**Spec:** `docs/superpowers/specs/2026-10-26-m5-backpressure-design.md`

## Global Constraints

- Reply and write docs in English; the owner's report is Vietnamese. Code comments and test names in English.
- Never log credentials or command payloads. Prompts, source and transcripts are sensitive.
- `git` only via argv arrays with `cwd`; never a shell string (§15.2).
- Never run `git reset`, `git clean`, `git stash`, `git checkout -f`, `git checkout -- .`, `git checkout -b`, `git checkout --track` (§15.5).
- Never edit generated shadcn-vue files: `apps/web/src/components/ui/**`, `apps/web/src/lib/utils.ts`, `apps/web/src/styles/index.css`, `components.json`.
- No version pinning: caret ranges only, `bun.lock` is truth.
- TDD RED→GREEN per task: the failing test is written and *observed to fail* before the implementation.
- Run tests with output redirected: `cmd &> /tmp/x.log; echo "exit=$?"` then Read the log. `cmd | tail` hides bun's output.
- Exact spec values, do not re-derive: `BATCH_BYTES_LIMIT = 256 * 1024`; linger/retry `LINGER_MS = 50`; warning `5_000` events or `16 * 1024 * 1024` payload bytes; critical `25_000` events or `64 * 1024 * 1024` payload bytes; `maxPayloadLength = 4 * 1024 * 1024`; browser over-limit close code `4002`; `DEFAULT_PENDING_LIMIT = 64`.
- The pump must never drop an event. There is no drop path in this plan, and no task may introduce one.

## Review Focus

1. **A frame silently lost while the server believes it was delivered.** Bun returns `0` from `send()` when the connection is closed or over `backpressureLimit`. A reasonable person expects an event the server accepted to reach the browser, or the operator to be told it did not. Every write path must distinguish "queued" from "dropped" (Task 5, Task 4).
2. **A quiet run leaving pending events unsent.** Today retry only happens on the next event or the next reconnect. A reasonable person expects an event appended to the outbox to ship within a bounded time even if the run then sits silent for minutes (Task 4).
3. **A single oversized event destroying the transcript.** A `Write` tool input is capped at 2,000 characters, but `message.completed` was measured at 8,240 bytes and the cap is not enforced by the pump. A reasonable person expects one large event to still be delivered, alone, rather than refused or split (Task 3).
4. **The critical threshold being crossed while the run reports success.** §12.6 forbids this in as many words. A reasonable person expects a run that could not keep its own journal to be reported failed, with the events it did produce still replayable (Task 6).
5. **A frame built from a smaller backlog behaving differently than one built from a huge backlog.** The pump read 38 MiB to build a 64-event frame at 100k depth. A reasonable person expects frame contents to depend on the events being sent, not on how far behind the spool is (Task 2, Task 1).

---

### Task 1: `pendingEvents` takes a LIMIT

**Files:**
- Modify: `packages/runner-db/src/event-outbox.ts:74-103`
- Modify: `packages/runner-db/src/index.ts` (export `DEFAULT_PENDING_LIMIT`)
- Test: `packages/runner-db/src/event-outbox.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `pendingEvents(db, attemptId, params?: { limit?: number }): PendingEvent[]` and `DEFAULT_PENDING_LIMIT: number` (64). Task 2 passes `{ limit }` explicitly; every other existing caller keeps working with the default.

- [ ] **Step 1: Write the failing test**

Add to `packages/runner-db/src/event-outbox.test.ts`, inside the existing `pendingEvents` describe block (create the block if the file has no matching one):

```ts
test("a limit caps how many unacked rows are read", () => {
  // The measured reason: at 100k unacked rows the un-limited read parsed
  // 38 MiB to build a 64-event frame. A LIMIT in SQL keeps the cost flat in
  // the backlog instead of linear in the whole transcript.
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  for (let i = 1; i <= 10; i += 1) {
    appendEvent(db, {
      eventId: `e${i}`,
      attemptId: "a1",
      localSequence: i,
      sessionId: "s1",
      runId: "r1",
      type: "message.delta",
      payload: { n: i },
      occurredAt: "2026-10-26T00:00:00.000Z",
    });
  }

  const limited = pendingEvents(db, "a1", { limit: 3 });
  expect(limited.map((row) => row.localSequence)).toEqual([1, 2, 3]);

  // The default stays bounded too: no caller gets an unbounded read by
  // forgetting to pass a limit.
  expect(DEFAULT_PENDING_LIMIT).toBe(64);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /mnt/Data/Ponta/cc-web && bun test packages/runner-db/src/event-outbox.test.ts &> /tmp/m5-t1.log; echo "exit=$?"`
Expected: FAIL — `pendingEvents` ignores the third argument, so `limited` has 10 elements, and `DEFAULT_PENDING_LIMIT` is `undefined`.

- [ ] **Step 3: Implement**

In `packages/runner-db/src/event-outbox.ts`, add above `pendingEvents`:

```ts
/**
 * How many unacknowledged rows one `pendingEvents` call reads when the caller
 * does not say. The pump's frame ceiling is the number that matters; this
 * default only exists so the floor below is never an unbounded read.
 */
export const DEFAULT_PENDING_LIMIT = 64;
```

Change the signature and the query:

```ts
export function pendingEvents(
  db: Database,
  attemptId: string,
  params: { limit?: number } = {},
): PendingEvent[] {
  const rows = db
    .prepare(
      `SELECT event_id, attempt_id, local_sequence, session_id, run_id, type, payload, occurred_at
       FROM event_outbox
       WHERE attempt_id = ? AND acknowledged = 0
       ORDER BY local_sequence ASC
       LIMIT ?`,
    )
    .all(attemptId, params.limit ?? DEFAULT_PENDING_LIMIT) as Array<{
```

Add `DEFAULT_PENDING_LIMIT` to the `event-outbox.ts` export block in `packages/runner-db/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /mnt/Data/Ponta/cc-web && bun test packages/runner-db &> /tmp/m5-t1.log; echo "exit=$?"`
Expected: `exit=0`, all pre-existing `runner-db` tests still pass (they call `pendingEvents` with two arguments).

- [ ] **Step 5: Commit**

```bash
git add packages/runner-db/src/event-outbox.ts packages/runner-db/src/event-outbox.test.ts packages/runner-db/src/index.ts
git commit -m "feat(runner-db): bound the outbox read with a SQL LIMIT"
```

---

### Task 2: `spoolDepth` reports unacked count and payload bytes

**Files:**
- Modify: `packages/runner-db/src/event-outbox.ts` (append the new function)
- Modify: `packages/runner-db/src/index.ts`
- Test: `packages/runner-db/src/event-outbox.test.ts`

**Interfaces:**
- Consumes: the outbox table only.
- Produces: `spoolDepth(db: Database, attemptId?: string): { events: number; bytes: number }`. Absent `attemptId` means every attempt. Task 6 calls it once per flush and compares against the spec's thresholds.

- [ ] **Step 1: Write the failing test**

```ts
test("spoolDepth counts unacked rows and their payload bytes", () => {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  const payload = { text: "x".repeat(100) };
  for (let i = 1; i <= 4; i += 1) {
    appendEvent(db, {
      eventId: `e${i}`,
      attemptId: i <= 3 ? "a1" : "a2",
      localSequence: i <= 3 ? i : 1,
      sessionId: "s1",
      runId: "r1",
      type: "message.delta",
      payload,
      occurredAt: "2026-10-26T00:00:00.000Z",
    });
  }

  const perAttempt = spoolDepth(db, "a1");
  expect(perAttempt.events).toBe(3);
  // The byte count is the stored JSON payload, not the parsed object: it is
  // what occupies the disk and what the thresholds are about.
  expect(perAttempt.bytes).toBe(JSON.stringify(payload).length * 3);

  expect(spoolDepth(db).events).toBe(4);

  // An ack shrinks the depth; the aggregate tracks the durable state, not a
  // counter kept alongside it.
  ackUpTo(db, { attemptId: "a1", sequence: 3 });
  expect(spoolDepth(db, "a1")).toEqual({ events: 0, bytes: 0 });
  expect(spoolDepth(db).events).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /mnt/Data/Ponta/cc-web && bun test packages/runner-db/src/event-outbox.test.ts &> /tmp/m5-t2.log; echo "exit=$?"`
Expected: FAIL — `spoolDepth is not a function`.

- [ ] **Step 3: Implement**

Append to `packages/runner-db/src/event-outbox.ts`:

```ts
/**
 * How much unacknowledged work is sitting in the outbox (§12.6).
 *
 * Counted from the durable rows rather than from a running counter, so the
 * number cannot drift from what a restart would find. `bytes` is the stored
 * payload length — the disk cost — not the parsed size.
 */
export function spoolDepth(
  db: Database,
  attemptId?: string,
): { events: number; bytes: number } {
  const query =
    attemptId === undefined
      ? `SELECT COUNT(*) AS events, COALESCE(SUM(LENGTH(payload)), 0) AS bytes
         FROM event_outbox WHERE acknowledged = 0`
      : `SELECT COUNT(*) AS events, COALESCE(SUM(LENGTH(payload)), 0) AS bytes
         FROM event_outbox WHERE acknowledged = 0 AND attempt_id = ?`;
  const row = (
    attemptId === undefined ? db.prepare(query).get() : db.prepare(query).get(attemptId)
  ) as { events: number; bytes: number } | null;
  return { events: row?.events ?? 0, bytes: row?.bytes ?? 0 };
}
```

Export it from `packages/runner-db/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /mnt/Data/Ponta/cc-web && bun test packages/runner-db &> /tmp/m5-t2.log; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add packages/runner-db/src/event-outbox.ts packages/runner-db/src/event-outbox.test.ts packages/runner-db/src/index.ts
git commit -m "feat(runner-db): report outbox spool depth"
```

---

### Task 3: The pump bounds a frame by bytes, and an oversized event goes alone

**Files:**
- Modify: `apps/runner/src/connection/event-pump.ts`
- Test: `apps/runner/src/connection/event-pump.test.ts`

**Interfaces:**
- Consumes: `pendingEvents(db, attemptId, { limit })` (Task 1).
- Produces: `EventPump.BATCH_BYTES_LIMIT = 256 * 1024` and a private `#selectBatch(attemptId): PendingEvent[]` that returns at most `BATCH_LIMIT` rows totalling at most `BATCH_BYTES_LIMIT` serialized bytes, always at least one row. Task 4 and Task 6 build on `#selectBatch`.

- [ ] **Step 1: Write the failing test**

Add a helper beside `append` that writes a large payload:

```ts
/** An event whose serialized wire form is roughly `bytes` long. */
function appendBig(db: Database, sequence: number, bytes: number) {
  const result = appendEvent(db, {
    eventId: `evt-big-${sequence}`,
    attemptId: "attempt-1",
    localSequence: sequence,
    sessionId: "session-1",
    runId: "run-1",
    type: "message.completed",
    payload: { text: "x".repeat(bytes) },
    occurredAt: "2026-10-24T00:00:00.000Z",
  });
  if (!result.ok) throw new Error("append failed in test setup");
}
```

Then, in `describe("flushing")`:

```ts
test("a frame is bounded in bytes, not only in events", () => {
  const { db, pump, frames } = setup();
  // 64 events at ~8 KiB each serialize to ~558 KiB, measured. The count
  // ceiling alone would put all of them in one frame.
  for (let i = 1; i <= 64; i += 1) appendBig(db, i, 8 * 1024);

  pump.flush();

  const frame = frames[0]!;
  const bytes = JSON.stringify(frame).length;
  expect(bytes).toBeLessThanOrEqual(EventPump.BATCH_BYTES_LIMIT);
  // Bounded, but not by refusing to send: the frame is a full one.
  expect(frame.events.length).toBeGreaterThan(1);
  expect(frame.events.length).toBeLessThan(EventPump.BATCH_LIMIT);
  // Order is preserved and the remainder is still owed.
  expect(frame.events[0]!.localSequence).toBe(1);
  expect(pendingEvents(db, "attempt-1").length).toBeGreaterThan(64 - frame.events.length);
});

test("an event too large for the byte ceiling still ships, alone", () => {
  const { db, pump, frames } = setup();
  appendBig(db, 1, EventPump.BATCH_BYTES_LIMIT + 4096);
  append(db, 2);

  pump.flush();

  // Refusing it would be the drop the spec forbids; splitting it would break
  // the event atomicity the server dedupes on. It goes alone, and the next
  // event goes in its own frame.
  expect(frames[0]!.events).toHaveLength(1);
  expect(frames[0]!.events[0]!.localSequence).toBe(1);
  expect(frames[1]!.events[0]!.localSequence).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /mnt/Data/Ponta/cc-web && bun test apps/runner/src/connection/event-pump.test.ts &> /tmp/m5-t3.log; echo "exit=$?"`
Expected: FAIL — `EventPump.BATCH_BYTES_LIMIT` is `undefined`, so `bytes <= undefined` is false; and the oversized event is batched with event 2 in the first frame.

- [ ] **Step 3: Implement**

In `apps/runner/src/connection/event-pump.ts`, add the constant below `BATCH_LIMIT`:

```ts
  /**
   * Bytes per frame, measured over the serialized frame — the same bytes Bun
   * buffers and compares against its own `backpressureLimit` (16 MiB default).
   * The measured worst case at the event ceiling is 558 KiB (64 events each
   * carrying an 8 KiB tool input); 256 KiB keeps a frame far below Bun's limit
   * while staying above the realistic 46–53 KiB frame, so ordinary traffic
   * still fills by count and pays no extra frames.
   */
  static readonly BATCH_BYTES_LIMIT = 256 * 1024;
```

Replace the body of `#flushAttempt`'s selection line with a call to the new private method, and add it:

```ts
  /**
   * The rows for one frame: at most `BATCH_LIMIT` events and at most
   * `BATCH_BYTES_LIMIT` serialized bytes, always at least one row.
   *
   * Sizing is done on the serialized wire event because that is what the
   * transport buffers; counting payload bytes would under-count the measured
   * 359 B/event of envelope by roughly 30% on a delta-heavy stream.
   */
  #selectBatch(attemptId: string): PendingEvent[] {
    const rows = pendingEvents(this.#db, attemptId, { limit: EventPump.BATCH_LIMIT });
    const selected: PendingEvent[] = [];
    let bytes = 0;

    for (const row of rows) {
      const event = this.#toWireEvent(row);
      const size = JSON.stringify(event).length;
      // The first row is always taken, however large: a single oversized
      // event is bounded by the per-event caps elsewhere in the pipeline, and
      // refusing it here would be the silent drop §12.6 forbids.
      if (selected.length > 0 && bytes + size > EventPump.BATCH_BYTES_LIMIT) break;
      selected.push(row);
      bytes += size;
    }

    return selected;
  }
```

`#flushAttempt` becomes:

```ts
  #flushAttempt(attemptId: string): boolean {
    const pending = this.#selectBatch(attemptId);
    if (pending.length === 0) return true;
    return this.#send({
      type: "events",
      events: pending.map((row) => this.#toWireEvent(row)),
    });
  }
```

Import `type PendingEvent` from `@cc-web/runner-db` (already imported).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /mnt/Data/Ponta/cc-web && bun test apps/runner/src/connection &> /tmp/m5-t3.log; echo "exit=$?"`
Expected: `exit=0`. The pre-existing "a batch is bounded" test still passes — 100 small events still fill by count.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/connection/event-pump.ts apps/runner/src/connection/event-pump.test.ts
git commit -m "feat(runner): bound an event frame by serialized bytes"
```

---

### Task 4: A refused send is retried on a timer

**Files:**
- Modify: `apps/runner/src/connection/event-pump.ts`
- Modify: `apps/runner/src/daemon.ts:200-210` (stop path)
- Test: `apps/runner/src/connection/event-pump.test.ts`

**Interfaces:**
- Consumes: `#selectBatch` (Task 3).
- Produces: `EventPump.LINGER_MS = 50`; an optional `EventPumpOptions.schedule?: (fn: () => void, ms: number) => unknown` seam (defaults to `setTimeout`) so tests drive the retry without sleeping; `EventPump.stop(): void` which clears any armed retry timer. Task 6 reuses the same seam for its own deferred work.

- [ ] **Step 1: Write the failing test**

```ts
test("a refused send is retried without waiting for another event", async () => {
  // A run that goes quiet (the SDK thinking, a long tool call) appends nothing
  // more, so nothing would ever retry a refused frame. The retry must be the
  // pump's own, on the link's terms, not the next event's.
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  const scheduled: Array<() => void> = [];
  let accept = false;
  const frames: EventBatchFrame[] = [];
  const pump = new EventPump({
    db,
    runnerId: "runner-a",
    bootId: "boot-1",
    send: (frame) => {
      frames.push(frame);
      return accept;
    },
    schedule: (fn) => {
      scheduled.push(fn);
      return undefined;
    },
  });

  append(db, 1);
  pump.flush();
  expect(frames).toHaveLength(1);
  expect(scheduled).toHaveLength(1);

  // The link comes back. The timer fires and the row ships, with no new event
  // and no reconnect in between.
  accept = true;
  scheduled.shift()!();
  expect(frames).toHaveLength(2);
  expect(frames[1]!.events[0]!.localSequence).toBe(1);

  // A successful flush disarms nothing and arms nothing: the timer is only
  // for refusals, so no latency is added to the ordinary path.
  expect(scheduled).toHaveLength(0);
});

test("a refusal arms one retry, not one per flush", () => {
  const { db, pump, scheduled } = setupWithSchedule(() => false);
  append(db, 1);
  append(db, 2);
  pump.flush();
  pump.flush();
  pump.flush();
  expect(scheduled).toHaveLength(1);
});
```

The existing `setup` helper gains a `schedule` parameter that collects the callbacks; add `setupWithSchedule` as a thin wrapper returning `{ db, pump, frames, scheduled }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /mnt/Data/Ponta/cc-web && bun test apps/runner/src/connection/event-pump.test.ts &> /tmp/m5-t4.log; echo "exit=$?"`
Expected: FAIL — `scheduled` has length 0 after a refused flush; the option is ignored.

- [ ] **Step 3: Implement**

In `apps/runner/src/connection/event-pump.ts`:

```ts
export type EventPumpOptions = {
  db: Database;
  runnerId: string;
  bootId: string;
  /** Hand a frame to the transport; false means it was not carried. */
  send: (frame: EventBatchFrame) => boolean;
  /**
   * How a retry is deferred. Defaults to `setTimeout`; tests inject a
   * collector so the retry is observed without waiting on wall time.
   */
  schedule?: (fn: () => void, ms: number) => unknown;
};
```

Add the constant and the state:

```ts
  /**
   * How long after a refused send the pump tries again (§12.6's time
   * threshold).
   *
   * It is deliberately a *retry* delay, not a batching delay: waiting before
   * a send would add this latency to every event in exchange for slightly
   * larger frames, and the byte measurement shows frames are already 46–53 KiB
   * without waiting. 50 ms is below human perception for a transcript that
   * just went quiet and far above the pump's own work (a bounded frame read is
   * 0.4 ms).
   */
  static readonly LINGER_MS = 50;
```

with `readonly #schedule` and `#retryArmed = false` fields, and:

```ts
  /**
   * Try again shortly after a refusal, at most one attempt in flight. Without
   * this, rows refused while a run is quiet would wait for the next event or
   * the next reconnect — neither of which is guaranteed to come.
   */
  #armRetry(): void {
    if (this.#retryArmed) return;
    this.#retryArmed = true;
    this.#schedule(() => {
      this.#retryArmed = false;
      this.flush();
    }, EventPump.LINGER_MS);
  }

  /** Disarm the retry. Called on daemon shutdown so it cannot outlive the db. */
  stop(): void {
    this.#retryArmed = false;
  }
```

In `flush()`, arm on refusal:

```ts
  flush(): void {
    for (const attemptId of pendingEventAttempts(this.#db)) {
      // A refused send means the link is down; every later attempt would be
      // refused too, and the rows stay pending for the next ready flush.
      if (!this.#flushAttempt(attemptId)) {
        this.#armRetry();
        return;
      }
    }
  }
```

`handleAck` keeps calling `#flushAttempt` directly; if that send is refused it also arms, so route it through a shared helper:

```ts
  handleAck(ack: { attemptId: string; through: number }): void {
    ackUpTo(this.#db, { attemptId: ack.attemptId, sequence: ack.through });
    if (!this.#flushAttempt(ack.attemptId)) this.#armRetry();
  }
```

In `apps/runner/src/daemon.ts`, in the `stop()` body, call `pump.stop()` before the database is closed (alongside the existing `loop.stop()`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /mnt/Data/Ponta/cc-web && bun test apps/runner/src/connection apps/runner/src/daemon.test.ts &> /tmp/m5-t4.log; echo "exit=$?"`
Expected: `exit=0`. If a daemon test hangs, the retry is outliving the test database — verify `stop()` calls `pump.stop()`.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/connection/event-pump.ts apps/runner/src/connection/event-pump.test.ts apps/runner/src/daemon.ts
git commit -m "feat(runner): retry a refused send on its own timer"
```

---

### Task 5: A dropped browser write is a failed send, not a delivery

**Files:**
- Modify: `apps/control-server/src/websocket/browser/browser-gateway.ts:39-43,297-316`
- Test: `apps/control-server/src/websocket/browser/browser-gateway.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `BrowserSocket.send(payload: string): number` (the type tightens from `unknown` to the number Bun returns); a `CLOSE_BACKPRESSURE = 4002` constant; `BrowserGateway.socketCountForSession(sessionId: string): number` (used by the test to assert the socket was dropped).

- [ ] **Step 1: Write the failing test**

In `browser-gateway.test.ts`, extend `makeSocket` with a controllable send status:

```ts
function makeSocket(sendStatus: number | (() => number) = 1) {
  const sent: Array<Record<string, unknown>> = [];
  const closed: number[] = [];
  const socket = {
    data: { userId: "", authenticated: false, subscriptions: new Set<string>() } as BrowserSocketData,
    send(payload: string) {
      // Bun returns 0 when the connection is closed or already over
      // backpressureLimit: the message was dropped, not queued.
      const status = typeof sendStatus === "function" ? sendStatus() : sendStatus;
      if (status !== 0) sent.push(JSON.parse(String(payload)) as Record<string, unknown>);
      return status;
    },
    close(code?: number) {
      closed.push(code ?? 1000);
    },
  };
  return { socket, sent, closed };
}
```

Then:

```ts
test("a send Bun reports as dropped disconnects the socket", async () => {
  // Bun's -1 means "queued under backpressure"; 0 means "dropped". Treating 0
  // as success is exactly the silent loss §12.6 forbids: the server would
  // believe the frame was delivered while the browser never saw it.
  const h = harness({ socket: makeSocket(0) });
  await h.subscribe();

  h.gateway.publish(replayEvent(4));

  expect(h.socket.sent).toHaveLength(0);
  expect(h.socket.closed).toContain(4002);
  // Dropped from the registry, so no later publish pays for this socket
  // again; the client's own reconnect + replay (§12.5) is the recovery.
  expect(h.gateway.socketCount(h.userId)).toBe(0);
});

test("a send Bun reports as queued under backpressure is NOT a drop", async () => {
  const h = harness({ socket: makeSocket(-1) });
  await h.subscribe();
  h.gateway.publish(replayEvent(4));
  // -1 is a success: the bytes are buffered and will be written. Closing here
  // would disconnect a browser that is merely behind.
  expect(h.socket.closed).toHaveLength(0);
  expect(h.gateway.socketCount(h.userId)).toBe(1);
});
```

(The test file already has a harness helper for authenticating and subscribing; reuse it and add the socket injection parameter rather than writing a second one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /mnt/Data/Ponta/cc-web && bun test apps/control-server/src/websocket/browser &> /tmp/m5-t5.log; echo "exit=$?"`
Expected: FAIL — the socket is never closed and stays registered, because `#send` ignores the return value.

- [ ] **Step 3: Implement**

In `browser-gateway.ts`:

```ts
export type BrowserSocket = {
  readonly data: BrowserSocketData;
  /**
   * Returns Bun's send status: `-1` queued under backpressure, `0` dropped
   * (closed, or over `backpressureLimit`), `1+` bytes sent.
   */
  send(payload: string): number;
  close(code?: number): unknown;
};
```

Add the close code beside the existing ones:

```ts
const CLOSE_POLICY = 1008;
const CLOSE_REVOKED = 4001;
/**
 * The connection could not take the frame Bun was asked to send. Distinct from
 * `CLOSE_REVOKED` so the client can tell "your login ended" from "you were too
 * far behind to keep up"; both are recovered by reconnect + replay (§12.5).
 */
export const CLOSE_BACKPRESSURE = 4002;
```

`#send` becomes:

```ts
  /**
   * One frame to one socket.
   *
   * The return value is the point of this method. Bun answers `-1` when the
   * bytes were queued under backpressure (a success — the socket is merely
   * behind) and `0` when the message was dropped because the connection is
   * closed or already past `backpressureLimit`. A `0` treated as success is
   * the silent loss §12.6 forbids, so it disconnects the socket instead: the
   * event is already durable in the journal, and the client's reconnect
   * replays the gap. There is no buffer here on purpose — Bun's own is
   * bounded, and a second one would only hide the same problem.
   */
  #send(socket: BrowserSocket, payload: Record<string, unknown>): void {
    let status: number;
    try {
      status = socket.send(JSON.stringify(payload));
    } catch {
      // A failed send surfaces as a close.
      status = 0;
    }
    if (status === 0) this.#disconnect(socket);
  }

  #disconnect(socket: BrowserSocket): void {
    this.handleClose(socket);
    try {
      socket.close(CLOSE_BACKPRESSURE);
    } catch {
      // Already gone; dropping it from the registry is what mattered.
    }
  }
```

`#reject` keeps its own `socket.send` call and must be left as is — a rejection is a close either way.

Add, beside `socketCount`:

```ts
  /** Subscribed-socket count across every user. Test seam for drop behavior. */
  socketCountForSession(sessionId: string): number {
    let count = 0;
    for (const sockets of this.#sockets.values()) {
      for (const socket of sockets) {
        if (socket.data.subscriptions.has(sessionId)) count += 1;
      }
    }
    return count;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /mnt/Data/Ponta/cc-web && bun test apps/control-server/src/websocket/browser &> /tmp/m5-t5.log; echo "exit=$?"`
Expected: `exit=0`, including the pre-existing subscribe/replay/publish tests. If `tsc` complains elsewhere about `send(payload: string): unknown`, the only implementer is `Bun.serve`'s socket, whose `send` already returns a number.

- [ ] **Step 5: Commit**

```bash
git add apps/control-server/src/websocket/browser/browser-gateway.ts apps/control-server/src/websocket/browser/browser-gateway.test.ts
git commit -m "fix(control): treat a dropped browser send as a failed delivery"
```

---

### Task 6: Spool thresholds, the warning signal, and the critical stop

**Files:**
- Modify: `packages/protocol/src/index.ts` (event type union + runtime list)
- Modify: `apps/runner/src/connection/event-pump.ts`
- Modify: `apps/runner/src/daemon.ts`
- Test: `packages/protocol/src/index.test.ts`, `apps/runner/src/connection/event-pump.test.ts`

**Interfaces:**
- Consumes: `spoolDepth(db, attemptId?)` (Task 2), `#selectBatch` and `#schedule` (Tasks 3, 4).
- Produces: `spool.warning` as an `EventType` member and an `EVENT_TYPES` entry; `EventPump.SPOOL_WARNING = { events: 5_000, bytes: 16 * 1024 * 1024 }` and `EventPump.SPOOL_CRITICAL = { events: 25_000, bytes: 64 * 1024 * 1024 }`; `EventPumpOptions.onSpoolCritical?: (info: { attemptId: string; events: number; bytes: number }) => void`; `EventPumpOptions.now?: () => number`.

- [ ] **Step 1: Write the failing tests**

In `packages/protocol/src/index.test.ts` (or the file that pins `EVENT_TYPES`):

```ts
test("spool.warning is a known event type", () => {
  // The union and the runtime list are checked against each other at compile
  // time; this pins that the new member reached both.
  expect(EVENT_TYPES).toContain("spool.warning");
  expect(isKnownEventType("spool.warning")).toBe(true);
});
```

In `apps/runner/src/connection/event-pump.test.ts`:

```ts
test("crossing the warning threshold emits one spool.warning", () => {
  const { db, pump, frames } = setup();
  // The threshold is on unacked depth, so the events stay unacknowledged.
  for (let i = 1; i <= EventPump.SPOOL_WARNING.events; i += 1) append(db, i);

  pump.flush();
  pump.flush();

  const warnings = frames.flatMap((f) => f.events).filter((e) => e.type === "spool.warning");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]!.payload).toMatchObject({ spoolEvents: expect.any(Number) });

  // The ingest admits this row because its event id is new and its borrowed
  // sequence still names a gap (the row it borrows from is unacked). Both
  // halves are asserted: a future change that allocates a fresh sequence
  // collides with UNIQUE (attempt_id, local_sequence) on the server, and a
  // change that reuses the event id is deduplicated into silence.
  const pendingIds = pendingEvents(db, "attempt-1").map((row) => row.eventId);
  expect(pendingIds).not.toContain(warnings[0]!.eventId);
  expect(warnings[0]!.localSequence).toBe(Math.max(...pendingEvents(db, "attempt-1").map((r) => r.localSequence)));
});

test("crossing the critical threshold stops the attempt and reports failure", () => {
  const { db, pump, frames, critical } = setupWithSchedule(() => true);
  for (let i = 1; i <= EventPump.SPOOL_CRITICAL.events; i += 1) append(db, i);

  pump.flush();

  // §12.6: never drop mandatory events and report success. The stop is
  // reported to the controller, which owns the run's SDK work.
  expect(critical).toHaveLength(1);
  expect(critical[0]!.attemptId).toBe("attempt-1");

  // The failure record ships ahead of the backlog, on its own frame, and
  // nothing in the backlog was deleted.
  const failure = frames
    .flatMap((f) => f.events)
    .find((e) => e.type === "run.failed");
  expect(failure?.payload).toMatchObject({ error: "spool_critical" });
  const remaining = pendingEvents(db, "attempt-1");
  expect(remaining.length).toBeGreaterThan(0);
  expect(remaining.some((row) => row.type === "run.failed")).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /mnt/Data/Ponta/cc-web && bun test packages/protocol apps/runner/src/connection/event-pump.test.ts &> /tmp/m5-t6.log; echo "exit=$?"`
Expected: FAIL — `spool.warning` is not in `EVENT_TYPES`; `EventPump.SPOOL_WARNING` is `undefined`.

- [ ] **Step 3: Implement**

`packages/protocol/src/index.ts`: add `"spool.warning"` to the `EventType` union (after `"usage.updated"`) and the same string to the `EVENT_TYPES` array. The existing `_EventTypesAreComplete` assertion fails to compile if only one of the two is edited.

`apps/runner/src/connection/event-pump.ts`:

```ts
  /**
   * Where the offline spool is deep enough to say so (§12.6).
   *
   * Reference points from the measurement: 5,000 unacked events is the first
   * depth at which an un-limited read of the outbox parses 1.9 MiB, and it is
   * one full frame 78× over. 25,000 sits between the 20k (9.6 MiB) and 50k
   * (25.3 MiB) measurements — the depth at which a single flush's accidental
   * full read would be a multi-tens-of-MiB allocation.
   */
  static readonly SPOOL_WARNING = { events: 5_000, bytes: 16 * 1024 * 1024 } as const;
  static readonly SPOOL_CRITICAL = { events: 25_000, bytes: 64 * 1024 * 1024 } as const;
```

State and options:

```ts
  /** Attempts already warned, so a warning is one event per crossing. */
  readonly #warned = new Set<string>();
  readonly #onSpoolCritical: ((info: {
    attemptId: string;
    events: number;
    bytes: number;
  }) => void) | undefined;
  readonly #now: () => number;
```

In `#flushAttempt`, before the send:

```ts
  #flushAttempt(attemptId: string): boolean {
    const depth = spoolDepth(this.#db, attemptId);

    if (depth.events >= EventPump.SPOOL_CRITICAL.events || depth.bytes >= EventPump.SPOOL_CRITICAL.bytes) {
      this.#reportCritical(attemptId, depth);
      return true;
    }

    if (depth.events >= EventPump.SPOOL_WARNING.events || depth.bytes >= EventPump.SPOOL_WARNING.bytes) {
      this.#warnSpool(attemptId, depth);
    } else {
      // Falls back below the threshold, so the next crossing warns again.
      this.#warned.delete(attemptId);
    }

    const pending = this.#selectBatch(attemptId);
    if (pending.length === 0) return true;
    return this.#send({
      type: "events",
      events: pending.map((row) => this.#toWireEvent(row)),
    });
  }
```

```ts
  /**
   * A signal, not a behaviour change: at warning the pump keeps sending
   * normally, once per crossing. A threshold that already changed behaviour
   * would just be a lower critical.
   */
  #warnSpool(attemptId: string, depth: { events: number; bytes: number }): void {
    if (this.#warned.has(attemptId)) return;
    this.#warned.add(attemptId);
    const pending = this.#selectBatch(attemptId);
    if (pending.length === 0) return;
    const last = pending[pending.length - 1]!;
    const frame: EventBatchFrame = {
      type: "events",
      events: [
        ...pending.map((row) => this.#toWireEvent(row)),
        {
          ...this.#toWireEvent(last),
          // A fresh identity: this is an observation about the spool, not a
          // resend of the row it borrows its attempt facts from.
          eventId: `${last.eventId}:spool-warning`,
          localSequence: last.localSequence,
          occurredAt: new Date(this.#now()).toISOString(),
          type: "spool.warning",
          payload: {
            spoolEvents: depth.events,
            spoolBytes: depth.bytes,
            warningEvents: EventPump.SPOOL_WARNING.events,
            warningBytes: EventPump.SPOOL_WARNING.bytes,
          },
        },
      ],
    };
    this.#send(frame);
  }

  /**
   * §12.6's critical policy, made mechanical: stop the run and report failure.
   *
   * The backlog is never deleted and never trimmed — the operator replays what
   * the run produced, then sees why it stopped. `run.failed` is written
   * runner-side by the controller, not here; the pump only tells it to stop,
   * and it is the controller's own failure path that emits the record. There
   * is no code path in which crossing this threshold ends in `run.finished`.
   */
  #reportCritical(attemptId: string, depth: { events: number; bytes: number }): void {
    this.#onSpoolCritical?.({ attemptId, events: depth.events, bytes: depth.bytes });
  }
```

**The borrowed sequence is safe, and here is the rule it was checked against.** `packages/control-db/src/db.ts:159` declares `UNIQUE (attempt_id, local_sequence)` on `run_events`. `ingestEvent` (`journal.ts:44-104`) looks the row up by `event_id` first: same `event_id` with matching content answers `duplicate`, same `event_id` with different content answers `conflict` and writes `event_ingest_conflicts`, anything else inserts. `sameObservation` (`journal.ts:133-146`) compares `local_sequence` among the other fields.

So a `spool.warning` carrying `eventId: `${last.eventId}:spool-warning`` and `last.localSequence` is admitted: the `event_id` is new, so no dedupe branch fires, and the `(attempt_id, local_sequence)` collision cannot happen because the borrowed sequence belongs to a row that is **still unacked** — `spoolDepth` only reaches the warning threshold on unacked rows, and unacked means the server holds no row for that sequence yet. The warning occupies a sequence the server has not filled. This is the same shape the executor already uses for `run.failed` on an attempt that never reached the SDK (`executor.ts:182`, `workspace_locked`).

The check the implementer owes here is behavioral, not documentary: assert in Step 1's test that the warning's `eventId` differs from every row in `pendingEvents`, and that its `localSequence` equals the last pending row's. That is the property the ingest relies on, and the property that breaks first if `#warnSpool` is ever changed to allocate its own sequence.

`apps/runner/src/daemon.ts` — wire the controller:

```ts
  const pump = new EventPump({
    db,
    runnerId: identity.runnerId,
    bootId: bootId(),
    send: (frame) => loop.sendFrame(frame),
    onSpoolCritical: (info) => runs.cancel(info.attemptId, "spool_critical"),
  });
```

and add to `RunController`:

```ts
  /**
   * Abort one in-flight run by attempt id (§12.6 critical policy). The run's
   * own terminal path writes the failure record; this only reaches the abort
   * handle, exactly like a user cancel.
   */
  cancel(attemptId: string, reason: string): void {
    const target = this.#findByAttemptId(attemptId);
    if (target === undefined) return;
    this.#cancelReasons.set(attemptId, reason);
    target.controller.abort();
  }
```

with `readonly #cancelReasons = new Map<string, string>()`.

The reason has to reach the executor's own terminal path, because the executor is what writes `run.failed` and it decides the event's payload. The plumbing is three small additions, in this order:

1. `ExecuteOptions.abortReason?: string` (`executor.ts:92-112`, next to `signal`), documented as "why this run's signal was aborted when it was aborted deliberately — `spool_critical`; absent for a user cancel or a shutdown, both of which already have their own reporting".
2. In `#flushAttempt`'s abort branch — the place that already distinguishes a deliberate abort from a thrown stream — `abortReason` wins over the generic error when it is set: `append("run.failed", { error: options.abortReason ?? sanitizeError(error) })`. The existing `sanitizeError` call stays for the non-abort path; the abort path must not pass an SDK error through, because a `spool_critical` stop that reported the SDK's `AbortError` message would tell the operator nothing about why the run ended.
3. `RunController` passes `abortReason: this.#cancelReasons.get(attemptId)` when constructing `executeRun`'s options (`run-controller.ts:241-256`), and deletes the map entry in the same `finally` that deletes `#inFlight` and `#routers` — a reason is consumed by exactly one run, and leaving it behind would mislabel a later attempt that reused the id.

Step 1's test asserts the outcome, not the plumbing: the `run.failed` payload seen on the frame carries `error: "spool_critical"`, and the version of the same test with no `onSpoolCritical` wired asserts that a plain user cancel still reports the generic error. That pair is what proves the reason is threaded rather than hardcoded.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /mnt/Data/Ponta/cc-web && bun test packages/protocol apps/runner &> /tmp/m5-t6.log; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/index.ts packages/protocol/src/index.test.ts apps/runner/src/connection/event-pump.ts apps/runner/src/connection/event-pump.test.ts apps/runner/src/daemon.ts apps/runner/src/execution/run-controller.ts apps/runner/src/execution/executor.ts
git commit -m "feat: spool warning and critical thresholds with an explicit stop"
```

---

### Task 7: Explicit `maxPayloadLength` on both servers

**Files:**
- Modify: `apps/control-server/src/server.ts:341-370`
- Modify: `apps/runner/src/connection/reconnect-loop.ts` (or wherever the runner dials) — only if the runner hosts a server; if it does not, this task covers the control server alone and says so.
- Test: `apps/control-server/src/server.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a shared constant. Put `export const WS_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;` in `packages/protocol/src/index.ts` so both apps import one number.

- [ ] **Step 1: Write the failing test**

```ts
test("the websocket accepts a legitimate frame and refuses an absurd one", async () => {
  // 4 MiB is ~7x the largest measured legitimate frame (558 KiB). An inbound
  // limit is free to tighten: a peer sending 16 MiB is not a peer we have a
  // use for, and an unbounded read is the amplification the limit removes.
  expect(WS_MAX_PAYLOAD_BYTES).toBe(4 * 1024 * 1024);
});
```

Where the server's config object is reachable, assert `websocket.maxPayloadLength === WS_MAX_PAYLOAD_BYTES` directly rather than through a live socket; a live 4 MiB round-trip in the unit suite is slower than the fact is worth.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /mnt/Data/Ponta/cc-web && bun test apps/control-server/src/server.test.ts packages/protocol &> /tmp/m5-t7.log; echo "exit=$?"`
Expected: FAIL — `WS_MAX_PAYLOAD_BYTES` is not exported.

- [ ] **Step 3: Implement**

`packages/protocol/src/index.ts`:

```ts
/**
 * The largest single WebSocket message either endpoint will accept (§12.6).
 *
 * Bun's default is 16 MiB, which is ~30× the largest measured legitimate frame
 * (558 KiB). An inbound limit is free to tighten, and this one turns "a 16 MiB
 * message occupies the peer until it is parsed" into a `1009` close at the
 * transport.
 */
export const WS_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
```

`apps/control-server/src/server.ts`, in the `websocket` object (as a sibling of `open`/`message`/`close`, not inside `runnerWebSocket`'s spread — verify the spread does not already set it):

```ts
    websocket: {
      // §12.6: bounded inbound payloads. Every legitimate frame is far below
      // this; the number exists so the ceiling is a decision rather than Bun's
      // default.
      maxPayloadLength: WS_MAX_PAYLOAD_BYTES,
      ...runnerWebSocket(runnerGateway),
```

If `open`/`message`/`close` are declared as literal methods after the spread, `maxPayloadLength` must be declared before the spread so a future `runnerWebSocket` returning the key does not silently win — check the value at runtime in the test rather than relying on order.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /mnt/Data/Ponta/cc-web && bun test apps/control-server &> /tmp/m5-t7.log; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/index.ts apps/control-server/src/server.ts apps/control-server/src/server.test.ts
git commit -m "feat: set an explicit websocket maxPayloadLength"
```

---

### Task 8: Milestone gates

**Files:** none modified; this task produces evidence.

**Interfaces:**
- Consumes: every earlier task.
- Produces: the gate results the milestone report cites.

- [ ] **Step 1: Run the full suite**

```bash
cd /mnt/Data/Ponta/cc-web && bun test &> /tmp/m5-gates.log; echo "exit=$?"
```

Read the log. Expected: `exit=0`, 0 failing tests, and a pass count at or above the 762 the M4 milestone ended on.

- [ ] **Step 2: Typecheck**

```bash
cd /mnt/Data/Ponta/cc-web && bun run typecheck &> /tmp/m5-tsc.log; echo "exit=$?"
```

Expected: `exit=0`. (This is `tsc -b --pretty && tsc -p apps/web --noEmit`.)

- [ ] **Step 3: Lint/format**

```bash
cd /mnt/Data/Ponta/cc-web && bunx biome check . &> /tmp/m5-biome.log; echo "exit=$?"
```

Expected: `exit=0`, no files flagged. Biome rewrites files between edits — re-Read any file before editing it again.

- [ ] **Step 4: Integration suite and web build**

```bash
cd /mnt/Data/Ponta/cc-web && bun run test:integration &> /tmp/m5-int.log; echo "exit=$?"
cd /mnt/Data/Ponta/cc-web/apps/web && bun run build &> /tmp/m5-web.log; echo "exit=$?"
cd /mnt/Data/Ponta/cc-web && bun test apps/web &> /tmp/m5-webtest.log; echo "exit=$?"
```

Expected: all `exit=0`. Note the integration script prints a check count; record it.

- [ ] **Step 5: Confirm no probe files were left behind**

```bash
cd /mnt/Data/Ponta/cc-web && git status --short
```

Expected: only intended source files. No `__m5*measure*` file, nothing under `/tmp` staged, no `docs/ZCode-*.rpm`.

---

## What is deliberately not in this plan

- **Enforcing a disk quota.** §12.6 lists "local disk quotas" alongside bounded queues. This plan ships the *signal* that precedes a quota problem (Task 6); refusing appends needs its own design for what the operator sees and what happens to the run. Ledger it.
- **A `drain`-driven browser pump.** Bun calls `drain` when a socket leaves backpressure, but the handler object does not declare it today, and a `-1` is already treated as success. Building a drain queue would be the "unlimited buffer" §12.6 warns against, in a smaller box. Ledger it.
- **A real slow-peer test.** Inducing genuine TCP backpressure in-process is flaky; the treatment is defined by the documented return values, which the tests pin. Ledger it.
- **Anything in `apps/web`.** The client already replays on reconnect (§12.5). A `1006` close from the over-limit path is indistinguishable from a network drop by design, and the reconnect path is the same one.
