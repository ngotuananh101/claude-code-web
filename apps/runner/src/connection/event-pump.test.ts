import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { EventBatchFrame } from "@cc-web/protocol";
import {
  appendEvent,
  migrateRunnerDb,
  pendingEventAttempts,
  pendingEvents,
  spoolDepth,
} from "@cc-web/runner-db";
import { EventPump, type SpoolReport } from "./event-pump.ts";

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

/**
 * A pump whose deferred work is collected instead of waiting on wall time.
 * A retry tests nothing if the assertion has to sleep for it. Also collects
 * the spool reports — the pump's other deferred decision, which it hands to
 * the controller rather than acting on itself: the pump cannot journal, because
 * the attempt's `local_sequence` space belongs to the executor alone (§12.2).
 */
function setupWithSchedule(send: (frame: EventBatchFrame) => boolean = () => true) {
  const db = new Database(":memory:");
  migrateRunnerDb(db);

  const frames: EventBatchFrame[] = [];
  const scheduled: Array<() => void> = [];
  const cancelled: unknown[] = [];
  const warnings: SpoolReport[] = [];
  const criticals: SpoolReport[] = [];
  const pump = new EventPump({
    db,
    runnerId: "runner-a",
    bootId: "boot-1",
    send: (frame) => {
      frames.push(frame);
      return send(frame);
    },
    schedule: (fn) => {
      scheduled.push(fn);
      // A live handle, so `unschedule` can be observed cancelling it.
      return fn;
    },
    unschedule: (handle) => {
      cancelled.push(handle);
    },
    onSpoolWarning: (info) => {
      warnings.push(info);
    },
    onSpoolCritical: (info) => {
      criticals.push(info);
    },
  });

  return { db, pump, frames, scheduled, cancelled, warnings, criticals };
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

/**
 * An event whose serialized wire form is `chars` multibyte characters long.
 * Used to pin that the byte ceiling counts bytes: for Vietnamese text the
 * encoded bytes exceed the code units by ~1.3×, so a code-unit measurement
 * would let a frame past the ceiling.
 */
function appendVietnamese(db: Database, sequence: number, chars: number) {
  const result = appendEvent(db, {
    eventId: `evt-vn-${sequence}`,
    attemptId: "attempt-1",
    localSequence: sequence,
    sessionId: "session-1",
    runId: "run-1",
    type: "message.completed",
    payload: { text: "đ".repeat(chars) },
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

  test("the byte ceiling counts UTF-8 bytes, not UTF-16 code units (§12.6)", () => {
    const { db, pump, frames } = setup();
    // Multibyte content — the repo's primary locale. Sized so the batch fits
    // under the ceiling by code units but not by the bytes actually on the
    // wire, which is what the ceiling's own doc promises to bound.
    const chars = Math.floor(EventPump.BATCH_BYTES_LIMIT / 2.6);
    for (let i = 1; i <= 8; i += 1) appendVietnamese(db, i, chars);

    pump.flush();

    const frame = frames[0]!;
    // The framed batch, measured the way the transport does.
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(
      EventPump.BATCH_BYTES_LIMIT,
    );
  });

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
    expect(pendingEvents(db, "attempt-1").length).toBe(64);
  });

  test("an event too large for the byte ceiling still ships, alone", () => {
    const { db, pump, frames } = setup();
    appendBig(db, 1, EventPump.BATCH_BYTES_LIMIT + 4096);
    append(db, 2);

    pump.flush();

    // Refusing it would be the drop the spec forbids; splitting it would break
    // the event atomicity the server dedupes on. It goes alone, on a frame of
    // its own — and it does not stall the stream behind it.
    expect(frames).toHaveLength(1);
    expect(frames[0]!.events).toHaveLength(1);
    expect(frames[0]!.events[0]!.localSequence).toBe(1);

    // The next trigger carries what the oversized frame left behind; the
    // oversized event costs one extra frame, not a stuck queue.
    pump.handleAck({ attemptId: "attempt-1", through: 1 });
    expect(frames).toHaveLength(2);
    expect(frames[1]!.events[0]!.localSequence).toBe(2);
  });

  test("a refused send is retried without waiting for another event", () => {
    let accept = false;
    const { db, pump, frames, scheduled } = setupWithSchedule(() => accept);
    append(db, 1);

    // A run that goes quiet — the SDK thinking, a long tool call — appends
    // nothing more, so nothing would ever retry a refused frame. The retry has
    // to be the pump's own, on the link's terms, not the next event's.
    pump.flush();
    expect(frames).toHaveLength(1);
    expect(scheduled).toHaveLength(1);

    // The link comes back. The timer fires and the row ships, with no new event
    // and no reconnect in between.
    accept = true;
    scheduled.shift()!();
    expect(frames).toHaveLength(2);
    expect(frames[1]!.events[0]!.localSequence).toBe(1);

    // A successful flush arms nothing: the timer exists for refusals, so the
    // ordinary path pays no added latency.
    expect(scheduled).toHaveLength(0);
  });

  test("a refusal arms one retry, not one per flush", () => {
    // Three refused flushes inside one linger window are still one outage. One
    // pending timer per pump is enough to cover it, and a timer per flush would
    // grow the queue with the event rate — the opposite of backpressure.
    const { db, pump, scheduled } = setupWithSchedule(() => false);
    append(db, 1);
    append(db, 2);

    pump.flush();
    pump.flush();
    pump.flush();

    expect(scheduled).toHaveLength(1);
  });

  test("stop cancels a pending retry timer instead of orphaning it", () => {
    // A refused flush arms a real timer. `stop()` that only sets a flag leaves
    // that timer live, and a live timer keeps the event loop alive after the
    // daemon has closed its database — a clean shutdown becomes a process that
    // will not exit.
    const { db, pump, scheduled, cancelled } = setupWithSchedule(() => false);
    append(db, 1);

    pump.flush();
    expect(scheduled).toHaveLength(1);
    expect(cancelled).toHaveLength(0);

    pump.stop();

    // The armed timer was handed back for cancellation, and firing it is inert:
    // the pump is stopped, so nothing is sent.
    expect(cancelled).toEqual(scheduled);
    scheduled.shift()!();
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

describe("spool thresholds (§12.6)", () => {
  /**
   * The pump reports the depth; it never journals. The attempt's
   * `local_sequence` space belongs to the executor alone — a second writer at a
   * borrowed sequence collides locally, at a fresh sequence collides with the
   * executor's next write, and either leaves a hole the ACK watermark stops at.
   * So the row is written by whoever owns the sequence (the controller, through
   * the executor's append); this unit pins the detection.
   */
  test("crossing the warning threshold reports once, not once per flush", () => {
    const { db, pump, frames, warnings } = setupWithSchedule();
    // The threshold is on unacked depth, so nothing is acknowledged here.
    for (let i = 1; i <= EventPump.SPOOL_WARNING.events; i += 1) append(db, i);

    pump.flush();
    pump.flush();
    pump.flush();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.attemptId).toBe("attempt-1");
    expect(warnings[0]!.events).toBeGreaterThanOrEqual(EventPump.SPOOL_WARNING.events);
    expect(typeof warnings[0]!.bytes).toBe("number");

    // A signal, not a behaviour change: the pump keeps sending and the backlog
    // is untouched. A threshold that already changed behaviour would just be a
    // lower critical.
    expect(frames.length).toBeGreaterThan(0);
    expect(spoolDepth(db, "attempt-1").events).toBe(EventPump.SPOOL_WARNING.events);
  });

  test("the warning re-arms once the depth falls back below the threshold", () => {
    const { db, pump, warnings } = setupWithSchedule();
    for (let i = 1; i <= EventPump.SPOOL_WARNING.events; i += 1) append(db, i);

    pump.flush();
    expect(warnings).toHaveLength(1);

    // Everything drains below the threshold, with a flush passing through the
    // low depth — that is the crossing that re-arms it.
    pump.handleAck({ attemptId: "attempt-1", through: EventPump.SPOOL_WARNING.events });
    append(db, EventPump.SPOOL_WARNING.events + 1);
    pump.flush();
    expect(warnings).toHaveLength(1);

    for (
      let i = EventPump.SPOOL_WARNING.events + 2;
      i <= EventPump.SPOOL_WARNING.events * 2;
      i += 1
    ) {
      append(db, i);
    }
    pump.flush();
    expect(warnings).toHaveLength(2);
  });

  test("crossing the critical threshold reports the stop once", () => {
    const { db, pump, frames, criticals } = setupWithSchedule();
    for (let i = 1; i <= EventPump.SPOOL_CRITICAL.events; i += 1) append(db, i);

    pump.flush();
    pump.flush();
    pump.flush();

    // §12.6: the stop is reported to the controller, which owns the run's SDK
    // work and its sequence. Once per crossing, never per flush.
    expect(criticals).toHaveLength(1);
    expect(criticals[0]!.attemptId).toBe("attempt-1");
    expect(criticals[0]!.events).toBeGreaterThanOrEqual(EventPump.SPOOL_CRITICAL.events);

    // Nothing is deleted, truncated or dropped: the backlog is kept on disk so
    // the operator replays what the run did, then sees why it stopped (§12.6
    // clause 3 — the transcript's order is the backlog, then the failure).
    expect(spoolDepth(db, "attempt-1").events).toBe(EventPump.SPOOL_CRITICAL.events);
    expect(pendingEventAttempts(db)).toContain("attempt-1");

    // The pump does not fabricate the failure record — it has no sequence to
    // write one at. Everything it sent is a real outbox row.
    const fabricated = frames
      .flatMap((f) => f.events)
      .filter((e) => e.type === "run.failed" || e.type === "spool.warning");
    expect(fabricated).toEqual([]);
  });

  test("at critical depth the warning is suppressed, not also fired", () => {
    const { db, pump, warnings, criticals } = setupWithSchedule();
    for (let i = 1; i <= EventPump.SPOOL_CRITICAL.events; i += 1) append(db, i);

    pump.flush();

    // The run is being stopped; a "the spool is getting deep" note is noise.
    expect(warnings).toHaveLength(0);
    expect(criticals).toHaveLength(1);
  });

  test("a shallow spool reports nothing", () => {
    const { db, pump, warnings, criticals } = setupWithSchedule();
    append(db, 1);
    append(db, 2);

    pump.flush();

    expect(warnings).toHaveLength(0);
    expect(criticals).toHaveLength(0);
  });
});
