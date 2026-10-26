import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrateRunnerDb } from "./db.ts";
import {
  ackUpTo,
  appendEvent,
  DEFAULT_PENDING_LIMIT,
  highestContiguousAcked,
  pendingEventAttempts,
  pendingEvents,
  spoolDepth,
} from "./event-outbox.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  return db;
}

const attempt = "attempt-1";

function append(db: Database, seq: number, type = "message.delta") {
  return appendEvent(db, {
    eventId: `evt-${seq}`,
    attemptId: attempt,
    localSequence: seq,
    sessionId: "session-1",
    runId: "run-1",
    type,
    payload: { n: seq },
    occurredAt: "2026-10-23T00:00:00.000Z",
    now: 1_000 + seq,
  });
}

describe("event outbox", () => {
  test("appends events with increasing local sequence", () => {
    const db = freshDb();
    expect(append(db, 1).ok).toBe(true);
    expect(append(db, 2).ok).toBe(true);
    expect(pendingEvents(db, attempt).map((e) => e.localSequence)).toEqual([1, 2]);
  });

  test("rejects a duplicate (attempt, sequence) instead of silently dropping it", () => {
    const db = freshDb();
    append(db, 1);
    const dup = append(db, 1);

    // §18.3: unique (attemptId, localSequence). A duplicate is a bug or a
    // conflicting sender — either way it must be visible, not swallowed.
    expect(dup).toEqual({ ok: false, reason: "duplicate_sequence" });
    expect(pendingEvents(db, attempt)).toHaveLength(1);
  });

  test("ACK advances only across a contiguous run", () => {
    const db = freshDb();
    append(db, 1);
    append(db, 2);
    append(db, 4); // gap: 3 missing

    // Server says it has 1..4, but 3 was never sent. Trusting the ACK number
    // would delete an event that still needs delivery.
    const result = ackUpTo(db, { attemptId: attempt, sequence: 4 });

    expect(result.ackedThrough).toBe(2);
    expect(highestContiguousAcked(db, attempt)).toBe(2);
    // 4 is still pending: it is not contiguous with what was acked.
    expect(pendingEvents(db, attempt).map((e) => e.localSequence)).toEqual([4]);
  });

  test("ACK of a sequence beyond what was appended does not invent a watermark", () => {
    const db = freshDb();
    append(db, 1);
    append(db, 2);

    const result = ackUpTo(db, { attemptId: attempt, sequence: 99 });

    expect(result.ackedThrough).toBe(2);
    expect(highestContiguousAcked(db, attempt)).toBe(2);
  });

  test("a late gap fill lets the watermark jump forward", () => {
    const db = freshDb();
    append(db, 1);
    append(db, 2);
    append(db, 4);
    ackUpTo(db, { attemptId: attempt, sequence: 4 }); // acks 2

    append(db, 3); // the missing event finally arrives
    const after = ackUpTo(db, { attemptId: attempt, sequence: 4 });

    // Now 1..4 are all present and acknowledged.
    expect(after.ackedThrough).toBe(4);
    expect(pendingEvents(db, attempt)).toHaveLength(0);
  });

  test("ACK is idempotent", () => {
    const db = freshDb();
    append(db, 1);
    append(db, 2);

    const first = ackUpTo(db, { attemptId: attempt, sequence: 2 });
    const second = ackUpTo(db, { attemptId: attempt, sequence: 2 });

    expect(first.ackedThrough).toBe(2);
    expect(second.ackedThrough).toBe(2);
  });

  test("a lower ACK never moves the watermark backwards", () => {
    const db = freshDb();
    append(db, 1);
    append(db, 2);
    append(db, 3);
    ackUpTo(db, { attemptId: attempt, sequence: 3 });

    const backwards = ackUpTo(db, { attemptId: attempt, sequence: 1 });
    expect(backwards.ackedThrough).toBe(3);
  });

  test("unacknowledged events survive and remain deliverable", () => {
    const db = freshDb();
    append(db, 1);
    append(db, 2);
    append(db, 3);
    ackUpTo(db, { attemptId: attempt, sequence: 2 });

    // §12.2: never delete an event that has not been ACKed.
    expect(pendingEvents(db, attempt).map((e) => e.localSequence)).toEqual([3]);
  });

  test("watermarks are per attempt, not shared", () => {
    const db = freshDb();
    append(db, 1);
    appendEvent(db, {
      eventId: "evt-b-1",
      attemptId: "attempt-2",
      localSequence: 1,
      sessionId: "session-1",
      runId: "run-1",
      type: "message.delta",
      payload: {},
      occurredAt: "2026-10-23T00:00:00.000Z",
      now: 2_000,
    });

    ackUpTo(db, { attemptId: attempt, sequence: 1 });

    expect(highestContiguousAcked(db, attempt)).toBe(1);
    // A replayed attempt must not inherit another attempt's progress.
    expect(highestContiguousAcked(db, "attempt-2")).toBe(0);
  });

  test("an event for an unknown attempt acks to zero, not to the requested number", () => {
    const db = freshDb();
    const result = ackUpTo(db, { attemptId: "never-existed", sequence: 5 });
    expect(result.ackedThrough).toBe(0);
  });
});

describe("pending attempts", () => {
  test("lists each attempt that still has an unacknowledged row", () => {
    const db = freshDb();
    append(db, 1);
    appendEvent(db, {
      eventId: "evt-other-1",
      attemptId: "attempt-2",
      localSequence: 1,
      sessionId: "session-2",
      runId: "run-2",
      type: "run.started",
      payload: {},
      occurredAt: "2026-10-23T00:00:00.000Z",
    });

    // The sender asks "who has work?" before asking "which rows?" — one query
    // per reconnect instead of a scan of every attempt's rows.
    expect(pendingEventAttempts(db)).toEqual(["attempt-1", "attempt-2"]);

    ackUpTo(db, { attemptId: attempt, sequence: 1 });
    expect(pendingEventAttempts(db)).toEqual(["attempt-2"]);
  });

  test("an empty outbox lists nothing", () => {
    const db = freshDb();
    expect(pendingEventAttempts(db)).toEqual([]);
  });
});

describe("pending event limits", () => {
  test("a limit caps how many unacked rows are read", () => {
    // The measured reason: at 100k unacked rows the un-limited read parsed
    // 38 MiB to build a 64-event frame. A LIMIT in SQL keeps the cost flat in
    // the backlog instead of linear in the whole transcript.
    const db = freshDb();
    for (let i = 1; i <= 10; i += 1) append(db, i);

    const limited = pendingEvents(db, attempt, { limit: 3 });
    expect(limited.map((row) => row.localSequence)).toEqual([1, 2, 3]);

    // The default stays bounded too: no caller gets an unbounded read by
    // forgetting to pass a limit.
    expect(DEFAULT_PENDING_LIMIT).toBe(64);
  });

  test("the limit is the frame ceiling, not a filter on the result", () => {
    // Reading 200 rows to slice 64 of them is the cost this replaces; the row
    // count is asserted through the default so a future caller that omits the
    // limit still cannot pull the whole transcript into one array.
    const db = freshDb();
    for (let i = 1; i <= 200; i += 1) append(db, i);

    expect(pendingEvents(db, attempt)).toHaveLength(DEFAULT_PENDING_LIMIT);
    // The rows returned are the oldest ones: a bounded read that skipped ahead
    // would break the contiguous ACK watermark (§12.2).
    expect(pendingEvents(db, attempt)[0]!.localSequence).toBe(1);
  });
});

describe("spool depth", () => {
  test("counts unacked rows and their stored payload bytes", () => {
    const db = freshDb();
    const payload = { text: "x".repeat(100) };
    appendEvent(db, {
      eventId: "e1",
      attemptId: "a1",
      localSequence: 1,
      sessionId: "s1",
      runId: "r1",
      type: "message.delta",
      payload,
      occurredAt: "2026-10-26T00:00:00.000Z",
    });
    appendEvent(db, {
      eventId: "e2",
      attemptId: "a1",
      localSequence: 2,
      sessionId: "s1",
      runId: "r1",
      type: "message.delta",
      payload,
      occurredAt: "2026-10-26T00:00:00.000Z",
    });
    appendEvent(db, {
      eventId: "e3",
      attemptId: "a2",
      localSequence: 1,
      sessionId: "s1",
      runId: "r1",
      type: "message.delta",
      payload,
      occurredAt: "2026-10-26T00:00:00.000Z",
    });

    const perAttempt = spoolDepth(db, "a1");
    expect(perAttempt.events).toBe(2);
    // The byte count is the stored JSON payload, not the parsed object: it is
    // what occupies the disk and what the thresholds are about.
    expect(perAttempt.bytes).toBe(JSON.stringify(payload).length * 2);

    expect(spoolDepth(db).events).toBe(3);
    expect(spoolDepth(db).bytes).toBe(JSON.stringify(payload).length * 3);
  });

  test("an ack shrinks the depth, because it is read from the durable rows", () => {
    const db = freshDb();
    append(db, 1);
    append(db, 2);
    append(db, 3);

    ackUpTo(db, { attemptId: attempt, sequence: 2 });

    expect(spoolDepth(db, attempt)).toEqual({
      events: 1,
      bytes: JSON.stringify({ n: 3 }).length,
    });
  });

  test("an empty or unknown spool is zero, not null", () => {
    // A threshold comparison against `null` would be quietly false, which is
    // how a critical spool goes unreported.
    const db = freshDb();
    expect(spoolDepth(db)).toEqual({ events: 0, bytes: 0 });
    expect(spoolDepth(db, "nobody")).toEqual({ events: 0, bytes: 0 });
  });
});
