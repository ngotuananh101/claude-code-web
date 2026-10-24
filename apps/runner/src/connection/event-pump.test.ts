import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { EventBatchFrame } from "@cc-web/protocol";
import {
  appendEvent,
  migrateRunnerDb,
  pendingEventAttempts,
  pendingEvents,
} from "@cc-web/runner-db";
import { EventPump } from "./event-pump.ts";

/**
 * The outbox → server sender (§12.2).
 *
 * Everything here is about the contract with an at-least-once peer:
 *
 *  - a send is one protocol frame per attempt, bounded, in sequence order
 *  - an ACK retires exactly the contiguous range it covers — never more
 *  - a failed or absent link leaves rows pending, which is what makes a
 *    reconnect-and-resend safe rather than lossy
 */

function setup(send: (frame: EventBatchFrame) => boolean = () => true) {
  const db = new Database(":memory:");
  migrateRunnerDb(db);

  const frames: EventBatchFrame[] = [];
  const pump = new EventPump({
    db,
    runnerId: "runner-a",
    bootId: "boot-1",
    send: (frame) => {
      frames.push(frame);
      return send(frame);
    },
  });

  return { db, pump, frames };
}

function append(db: Database, sequence: number, attemptId = "attempt-1") {
  const result = appendEvent(db, {
    eventId: `evt-${attemptId}-${sequence}`,
    attemptId,
    localSequence: sequence,
    sessionId: "session-1",
    runId: "run-1",
    type: "message.completed",
    payload: { n: sequence },
    occurredAt: "2026-10-24T00:00:00.000Z",
  });
  if (!result.ok) throw new Error("append failed in test setup");
}

describe("flushing", () => {
  test("sends one frame per attempt with the wire identity attached", () => {
    const { db, pump, frames } = setup();
    append(db, 1);
    append(db, 2);
    append(db, 3, "attempt-2");

    pump.flush();

    expect(frames).toHaveLength(2);

    const first = frames[0]!;
    expect(first.type).toBe("events");
    // The rows carry the attempt's facts; the wire identity (protocol version,
    // runner, boot) is the pump's to attach — it is per-process, not per-row.
    expect(first.events.map((e) => [e.eventId, e.localSequence, e.runnerId, e.bootId])).toEqual([
      ["evt-attempt-1-1", 1, "runner-a", "boot-1"],
      ["evt-attempt-1-2", 2, "runner-a", "boot-1"],
    ]);
    expect(first.events.every((e) => e.protocolVersion === 1)).toBe(true);

    expect(frames[1]!.events).toHaveLength(1);
  });

  test("a batch is bounded, and the ack of a batch pumps the next one", () => {
    const { db, pump, frames } = setup();
    for (let i = 1; i <= 100; i++) append(db, i);

    pump.flush();
    // §12.6: bounded frames. One row per event with no ceiling is how a
    // multi-megabyte transcript lands on a socket as a single allocation.
    expect(frames).toHaveLength(1);
    expect(frames[0]!.events).toHaveLength(EventPump.BATCH_LIMIT);

    pump.handleAck({ attemptId: "attempt-1", through: EventPump.BATCH_LIMIT });

    // The ack retired the first batch; the remainder is still pending, and the
    // pump sends it without being told to — the drain is self-driving.
    expect(frames).toHaveLength(2);
    expect(frames[1]!.events).toHaveLength(100 - EventPump.BATCH_LIMIT);
    expect(frames[1]!.events[0]!.localSequence).toBe(EventPump.BATCH_LIMIT + 1);

    pump.handleAck({ attemptId: "attempt-1", through: 100 });
    expect(pendingEventAttempts(db)).toEqual([]);
  });

  test("a refused send leaves everything pending and nothing throws", () => {
    const { db, pump, frames } = setup(() => false);
    append(db, 1);
    append(db, 2);

    // The link is down. The single refused frame covers the whole attempt
    // (both rows, one batch), and the rows stay pending — the next ready
    // flush resends them, and the server deduplicates what did land.
    expect(() => pump.flush()).not.toThrow();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.events).toHaveLength(2);
    expect(pendingEvents(db, "attempt-1")).toHaveLength(2);
  });

  test("flushing with nothing pending sends nothing", () => {
    const { pump, frames } = setup();
    pump.flush();
    expect(frames).toHaveLength(0);
  });
});

describe("acknowledging", () => {
  test("an ack retires only the contiguous range it covers", () => {
    const { db, pump } = setup();
    append(db, 1);
    append(db, 2);

    // The server never acks past a gap (§12.2), but the pump must not trust
    // that on faith: ackUpTo clamps the number to what is contiguous locally.
    pump.handleAck({ attemptId: "attempt-1", through: 99 });
    expect(pendingEventAttempts(db)).toEqual([]);
  });

  test("an ack for an unknown attempt is a no-op", () => {
    const { pump } = setup();
    expect(() => pump.handleAck({ attemptId: "attempt-nobody", through: 3 })).not.toThrow();
  });
});
