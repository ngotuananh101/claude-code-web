import { describe, expect, test } from "bun:test";
import { createStreamNormalizer } from "./stream-normalizer.ts";

/** A stream_event wrapper as the SDK delivers it (only the fields we read). */
function streamEvent(
  event: Record<string, unknown>,
  parentToolUseId: string | null = null,
): Record<string, unknown> {
  return { type: "stream_event", event, parent_tool_use_id: parentToolUseId };
}

function messageStart(id: string): Record<string, unknown> {
  return { type: "message_start", message: { id } };
}

function textDelta(text: string): Record<string, unknown> {
  return { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
}

describe("createStreamNormalizer", () => {
  test("message_start emits message.started with the message id", () => {
    const normalize = createStreamNormalizer();
    expect(normalize(streamEvent(messageStart("msg_1")))).toEqual([
      { type: "message.started", payload: { messageId: "msg_1" } },
    ]);
  });

  test("text deltas after message_start emit one message.delta per fragment", () => {
    const normalize = createStreamNormalizer();
    normalize(streamEvent(messageStart("msg_1")));
    expect(normalize(streamEvent(textDelta("Hel")))).toEqual([
      { type: "message.delta", payload: { messageId: "msg_1", text: "Hel" } },
    ]);
    expect(normalize(streamEvent(textDelta("lo")))).toEqual([
      { type: "message.delta", payload: { messageId: "msg_1", text: "lo" } },
    ]);
  });

  test("thinking deltas emit nothing", () => {
    const normalize = createStreamNormalizer();
    normalize(streamEvent(messageStart("msg_1")));
    expect(
      normalize(
        streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "hm" },
        }),
      ),
    ).toEqual([]);
  });

  test("tool input fragments emit nothing", () => {
    const normalize = createStreamNormalizer();
    normalize(streamEvent(messageStart("msg_1")));
    expect(
      normalize(
        streamEvent({
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"cmd"' },
        }),
      ),
    ).toEqual([]);
  });

  test("a delta before any message_start emits nothing", () => {
    const normalize = createStreamNormalizer();
    expect(normalize(streamEvent(textDelta("orphan")))).toEqual([]);
  });

  test("sidechain and main-chain ids do not bleed", () => {
    const normalize = createStreamNormalizer();
    normalize(streamEvent(messageStart("msg_main")));
    normalize(streamEvent(messageStart("msg_sub"), "tool-1"));
    expect(normalize(streamEvent(textDelta("sub text"), "tool-1"))).toEqual([
      { type: "message.delta", payload: { messageId: "msg_sub", text: "sub text" } },
    ]);
    expect(normalize(streamEvent(textDelta("main text")))).toEqual([
      { type: "message.delta", payload: { messageId: "msg_main", text: "main text" } },
    ]);
  });

  test("a second message_start on the same chain replaces the current id", () => {
    const normalize = createStreamNormalizer();
    normalize(streamEvent(messageStart("msg_1")));
    normalize(streamEvent(messageStart("msg_2")));
    expect(normalize(streamEvent(textDelta("next")))).toEqual([
      { type: "message.delta", payload: { messageId: "msg_2", text: "next" } },
    ]);
  });

  test("non-delta raw events emit nothing", () => {
    const normalize = createStreamNormalizer();
    normalize(streamEvent(messageStart("msg_1")));
    expect(normalize(streamEvent({ type: "message_stop" }))).toEqual([]);
    expect(
      normalize(
        streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      ),
    ).toEqual([]);
    expect(normalize(streamEvent({ type: "content_block_stop", index: 0 }))).toEqual([]);
    expect(
      normalize(streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } })),
    ).toEqual([]);
  });

  test("payloads carry no raw event fields", () => {
    const normalize = createStreamNormalizer();
    const events = [
      ...normalize(streamEvent(messageStart("msg_1"))),
      ...normalize(streamEvent(textDelta("hi"))),
    ];
    for (const normalized of events) {
      expect(Object.keys(normalized.payload).sort()).toEqual(
        normalized.type === "message.started" ? ["messageId"] : ["messageId", "text"],
      );
    }
  });

  test("malformed frames emit nothing instead of throwing", () => {
    const normalize = createStreamNormalizer();
    expect(normalize(streamEvent({ type: "message_start" }))).toEqual([]);
    expect(normalize(streamEvent(messageStart(42 as unknown as string)))).toEqual([]);
    expect(normalize(streamEvent({ type: "content_block_delta" }))).toEqual([]);
    expect(normalize({ type: "stream_event" })).toEqual([]);
    expect(normalize(streamEvent(textDelta("x")))).toEqual([]);
  });
});
