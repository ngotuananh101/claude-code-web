import { describe, expect, test } from "bun:test";
import type { BrowserReplayEvent, SessionEventsFrame, SessionResyncFrame } from "@cc-web/protocol";
import { createSessionStream } from "./session-stream.ts";

/**
 * The browser's replay state machine (§12.5's client half).
 *
 * Everything the §12.5 protocol can throw at a client, decided once here and
 * nowhere in a component: dedup by session_sequence, gap → resubscribe from
 * what the client actually holds, resync_required → rewind to the earliest
 * surviving event. The machine is pure — it never opens a socket; `send` is
 * injected and recorded.
 */

function replayEvent(seq: number, overrides: Partial<BrowserReplayEvent> = {}): BrowserReplayEvent {
  return {
    sessionSequence: seq,
    eventId: `evt-${seq}`,
    runId: "run-1",
    attemptId: "attempt-1",
    occurredAt: "2026-10-24T00:00:00.000Z",
    type: "message.delta",
    payload: { n: seq },
    ...overrides,
  };
}

function batch(events: BrowserReplayEvent[], live = false): SessionEventsFrame {
  return {
    type: "session.events",
    sessionId: "session-1",
    live,
    through: events.length > 0 ? events[events.length - 1]!.sessionSequence : 0,
    events,
  };
}

const resync = (fromSequence: number): SessionResyncFrame => ({
  type: "session.resync_required",
  sessionId: "session-1",
  fromSequence,
});

function harness() {
  const sent: Array<{ type: string; afterSessionSequence: number }> = [];
  const stream = createSessionStream({
    sessionId: "session-1",
    send: (frame) =>
      sent.push({ type: frame.type, afterSessionSequence: frame.afterSessionSequence }),
  });
  return { stream, sent };
}

describe("the session stream state machine", () => {
  test("a replay batch appends in order and advances through", () => {
    const { stream } = harness();

    stream.apply(batch([replayEvent(1), replayEvent(2), replayEvent(3)]));
    expect(stream.state().through).toBe(3);
    expect(stream.state().events.map((e) => e.sessionSequence)).toEqual([1, 2, 3]);
    expect(stream.state().live).toBe(false);

    stream.apply(batch([replayEvent(4)], true));
    expect(stream.state().through).toBe(4);
    expect(stream.state().live).toBe(true);
  });

  test("re-delivered events are dropped by sessionSequence", () => {
    const { stream, sent } = harness();
    stream.apply(batch([replayEvent(1), replayEvent(2), replayEvent(3)]));

    // A lost ACK replays the tail on reconnect; the client's own watermark,
    // not the server's frame, decides what is new.
    stream.apply(batch([replayEvent(2), replayEvent(3), replayEvent(4)]));

    expect(stream.state().events.map((e) => e.sessionSequence)).toEqual([1, 2, 3, 4]);
    expect(stream.state().through).toBe(4);
    expect(sent).toEqual([]);
  });

  test("a gap rewinds from what the client holds instead of appending", () => {
    const { stream, sent } = harness();
    stream.apply(batch([replayEvent(1), replayEvent(2)]));

    stream.apply(batch([replayEvent(5), replayEvent(6)]));

    // 5 and 6 are not appended — a transcript with a hole is a lie. The
    // client resubscribes from its own watermark so the server re-serves the
    // missing range; what it already holds stays on screen.
    stream.apply(batch([replayEvent(5), replayEvent(6)]));
    expect(stream.state().events.map((e) => e.sessionSequence)).toEqual([1, 2]);
    expect(stream.state().through).toBe(2);
    expect(sent).toEqual([{ type: "subscribe", afterSessionSequence: 2 }]);

    // The re-replay fills the hole and stream re-joins the tail.
    stream.apply(batch([replayEvent(3), replayEvent(4), replayEvent(5), replayEvent(6)]));
    expect(stream.state().events.map((e) => e.sessionSequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("only one resubscribe is in flight no matter how much out-of-order arrives", () => {
    const { stream, sent } = harness();
    stream.apply(batch([replayEvent(1), replayEvent(2)]));

    stream.apply(batch([replayEvent(5)]));
    stream.apply(batch([replayEvent(7)]));
    stream.apply(batch([replayEvent(9)]));

    expect(sent).toEqual([{ type: "subscribe", afterSessionSequence: 2 }]);
  });

  test("resync_required rewinds to the earliest surviving event", () => {
    const { stream, sent } = harness();
    stream.apply(batch([replayEvent(1), replayEvent(2)]));

    // Retention deleted 1..2 (§12.5): everything the client holds is outside
    // the journal now, so the transcript restarts at fromSequence — the
    // subscribe asks for fromSequence - 1 so that boundary event is served.
    stream.apply(resync(3));

    expect(stream.state().events).toEqual([]);
    expect(stream.state().through).toBe(2);
    expect(stream.state().needsResync).toBe(true);
    expect(sent).toEqual([{ type: "subscribe", afterSessionSequence: 2 }]);

    stream.apply(batch([replayEvent(3), replayEvent(4)]));
    expect(stream.state().events.map((e) => e.sessionSequence)).toEqual([3, 4]);
    expect(stream.state().needsResync).toBe(false);
  });

  test("attempts interleaving in one session stays contiguous without a resubscribe", () => {
    const { stream, sent } = harness();

    // Two attempts write one session's transcript; session_sequence is the
    // only order the client may reason about (§12.5).
    stream.apply(batch([replayEvent(1), replayEvent(2, { attemptId: "attempt-a" })]));
    stream.apply(batch([replayEvent(3, { attemptId: "attempt-b" })]));
    stream.apply(batch([replayEvent(4, { attemptId: "attempt-a" })]));

    expect(stream.state().events.map((e) => e.attemptId)).toEqual([
      "attempt-1",
      "attempt-a",
      "attempt-b",
      "attempt-a",
    ]);
    expect(stream.state().through).toBe(4);
    expect(sent).toEqual([]);
  });

  test("resume after a drop dedups the overlap and stays one transcript", () => {
    const { stream, sent } = harness();
    stream.apply(batch([replayEvent(1), replayEvent(2), replayEvent(3)]));

    // The socket died and came back; the client resubscribed from 0 and the
    // whole history arrives again ahead of the new tail.
    stream.apply(batch([replayEvent(1), replayEvent(2), replayEvent(3), replayEvent(4)]));

    expect(stream.state().events.map((e) => e.sessionSequence)).toEqual([1, 2, 3, 4]);
    expect(stream.state().through).toBe(4);
    expect(sent).toEqual([]);
  });
});
