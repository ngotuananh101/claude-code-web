import { describe, expect, test } from "bun:test";
import { MAX_EVENT_PAYLOAD_BYTES } from "@cc-web/protocol";
import { boundEventPayload } from "./payload-bound.ts";

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "");
}

/**
 * The per-event ceiling (§12.6).
 *
 * The transport rejects a frame larger than `WS_MAX_PAYLOAD_BYTES`. An event
 * whose own row exceeds that can never be delivered, and because the row is
 * durable it is refused on every replay — the link closes and the same event
 * comes back. Bounding the payload before it is persisted is what breaks that
 * loop; the frame's "always send one event" guard is only safe because of it.
 */
describe("bounding an event payload", () => {
  test("a payload under the ceiling is returned unchanged", () => {
    const payload = { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
    // Identity, not equality: a small event pays for no copy.
    expect(boundEventPayload(payload)).toBe(payload);
  });

  test("a huge payload is brought under the ceiling", () => {
    const payload = { type: "assistant", text: "x".repeat(MAX_EVENT_PAYLOAD_BYTES * 2) };
    const bounded = boundEventPayload(payload);
    expect(bytesOf(bounded)).toBeLessThanOrEqual(MAX_EVENT_PAYLOAD_BYTES);
  });

  test("bounding keeps the small identity keys the browser pairs on", () => {
    // The shape a `message.completed` actually carries: an id the journal keys
    // on, and the text it renders.
    const payload = {
      id: "msg_1",
      type: "assistant",
      message: { content: [{ type: "text", text: "y".repeat(MAX_EVENT_PAYLOAD_BYTES * 2) }] },
    };
    const bounded = boundEventPayload(payload) as Record<string, unknown>;

    expect(bounded["id"]).toBe("msg_1");
    expect(bounded["type"]).toBe("assistant");
    expect(bytesOf(bounded)).toBeLessThanOrEqual(MAX_EVENT_PAYLOAD_BYTES);
  });

  test("truncation is marked, not silent", () => {
    const payload = { text: "z".repeat(MAX_EVENT_PAYLOAD_BYTES * 2) };
    const bounded = boundEventPayload(payload) as Record<string, unknown>;
    // A reader can tell the text was cut and by how much; the alternative is a
    // silently shortened transcript, which the spec forbids (§12.6).
    expect(String(bounded["text"])).toContain("truncated");
  });

  test("a pathological many-key payload still lands under the ceiling", () => {
    const payload: Record<string, string> = {};
    for (let i = 0; i < 500; i += 1) payload[`k${i}`] = "v".repeat(8192);
    const bounded = boundEventPayload(payload);
    expect(bytesOf(bounded)).toBeLessThanOrEqual(MAX_EVENT_PAYLOAD_BYTES);
  });

  test("the bound counts UTF-8 bytes, so multibyte text is cut where it says", () => {
    const payload = { text: "đ".repeat(MAX_EVENT_PAYLOAD_BYTES) };
    const bounded = boundEventPayload(payload);
    expect(bytesOf(bounded)).toBeLessThanOrEqual(MAX_EVENT_PAYLOAD_BYTES);
    // The kept prefix is valid text, not a half-encoded character.
    expect(() => JSON.parse(JSON.stringify(bounded))).not.toThrow();
  });
});
