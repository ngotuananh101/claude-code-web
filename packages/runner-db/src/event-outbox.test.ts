import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrateRunnerDb } from "./db.ts";
import { ackUpTo, appendEvent, highestContiguousAcked, pendingEvents } from "./event-outbox.ts";

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
