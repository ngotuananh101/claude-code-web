import { describe, expect, test } from "bun:test";
import { type EventBatchFrame, type RunnerEvent, serializeEventBatch } from "./index.ts";

/**
 * The batch frame's wire text, built from event text that has already been
 * serialized.
 *
 * The runner measures each event against the frame ceiling before it adds the
 * event, then hands the transport exactly the text it measured. That promise
 * only holds while the helper produces byte-for-byte what `JSON.stringify` of
 * the frame would — the envelope is written by hand here, so the coupling
 * needs a pin.
 */

function event(overrides: Partial<RunnerEvent> = {}): RunnerEvent {
  return {
    protocolVersion: 1,
    eventId: "evt-1",
    runnerId: "runner-a",
    bootId: "boot-1",
    sessionId: "session-1",
    runId: "run-1",
    attemptId: "attempt-1",
    localSequence: 1,
    occurredAt: "2026-10-26T00:00:00.000Z",
    type: "message.delta",
    payload: { text: "nội dung" },
    ...overrides,
  };
}

describe("event batch serialization", () => {
  test("hand-built text is exactly JSON.stringify of the frame", () => {
    const events = [
      event(),
      event({ eventId: "evt-2", localSequence: 2, payload: { nested: { text: "đ" } } }),
    ];
    const frame: EventBatchFrame = { type: "events", events };

    const text = serializeEventBatch(events.map((e) => JSON.stringify(e)).join(","));

    expect(text).toBe(JSON.stringify(frame));
    expect(JSON.parse(text)).toEqual(frame);
  });

  test("an empty batch is the empty frame", () => {
    expect(serializeEventBatch("")).toBe(JSON.stringify({ type: "events", events: [] }));
  });
});
