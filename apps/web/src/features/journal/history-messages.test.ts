import { describe, expect, test } from "bun:test";
import type { SessionMessage } from "@cc-web/protocol";
import { deriveHistoryRows, hasProse, messageTextOf } from "./history-messages.ts";

/**
 * Unit tests for the historical-message replay helpers (§16.1, Task 13).
 *
 * These pin the contract `EventJournal.vue` relies on: extracting prose from the
 * tolerated message shapes and never throwing on a malformed entry. The Vue
 * SFC itself is rendered in a browser, not here, so the surface under test is
 * this pure module — the codebase convention set by `streaming-messages.test.ts`.
 */

function user(content: unknown): SessionMessage {
  return { type: "user", uuid: "u-1", message: content };
}
function assistant(content: unknown): SessionMessage {
  return { type: "assistant", uuid: "a-1", message: content };
}
function system(content: unknown): SessionMessage {
  return { type: "system", uuid: "s-1", message: content };
}

describe("messageTextOf", () => {
  test("reads a user message with a plain string content", () => {
    expect(messageTextOf(user({ content: "hello there" }))).toBe("hello there");
  });

  test("joins assistant text blocks with a blank line", () => {
    const text = messageTextOf(
      assistant({
        type: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      }),
    );
    expect(text).toBe("first\n\nsecond");
  });

  test("skips non-text content blocks (tool_use) defensively", () => {
    const text = messageTextOf(
      assistant({
        content: [
          { type: "text", text: "running it" },
          { type: "tool_use", id: "toolu-1", name: "Bash", input: { command: "ls" } },
        ],
      }),
    );
    expect(text).toBe("running it");
  });

  test("reads a system message with string content", () => {
    expect(messageTextOf(system({ content: "you are helpful" }))).toBe("you are helpful");
  });

  test("a message whose content is not extractable yields an empty string", () => {
    expect(messageTextOf(user({ content: 42 }))).toBe("");
    expect(messageTextOf(user({}))).toBe("");
    expect(messageTextOf(assistant({ content: [{ type: "image", data: "..." }] }))).toBe("");
  });

  test("a null message yields an empty string", () => {
    expect(messageTextOf({ type: "user", uuid: "x", message: null })).toBe("");
  });
});

describe("deriveHistoryRows", () => {
  test("preserves order and tags each row by uuid", () => {
    const messages: SessionMessage[] = [
      { type: "user", uuid: "u-1", message: { content: "hello" } },
      { type: "assistant", uuid: "a-1", message: { content: "hi back" } },
      { type: "system", uuid: "s-1", message: { content: "note" } },
    ];
    const rows = deriveHistoryRows(messages);
    expect(rows.map((r) => r.key)).toEqual(["history-u-1", "history-a-1", "history-s-1"]);
    expect(rows.map((r) => r.type)).toEqual(["user", "assistant", "system"]);
    expect(rows.map((r) => r.text)).toEqual(["hello", "hi back", "note"]);
    expect(rows.every((r) => r.rendered === "")).toBe(true);
  });

  test("an empty message list yields no rows", () => {
    expect(deriveHistoryRows([])).toEqual([]);
  });

  test("a non-prose message carries a JSON fallback in `rendered`", () => {
    const rows = deriveHistoryRows([user({ content: { unexpected: "shape" } })]);
    expect(rows[0]!.text).toBe("");
    expect(hasProse(rows[0]!)).toBe(false);
    expect(rows[0]!.rendered).toContain('"unexpected"');
    expect(rows[0]!.rendered).toContain("shape");
    // The full message object is serialized, so the fallback preserves shape.
    expect(rows[0]!.rendered).toContain('"content"');
  });

  test("a null message carries a null JSON fallback", () => {
    const rows = deriveHistoryRows([{ type: "user", uuid: "u", message: null }]);
    expect(rows[0]!.text).toBe("");
    expect(rows[0]!.rendered).toBe("null");
  });
});

describe("hasProse", () => {
  test("true when text is non-empty, false otherwise", () => {
    expect(hasProse({ key: "k", uuid: "u", type: "user", text: "hi", rendered: "" })).toBe(true);
    expect(hasProse({ key: "k", uuid: "u", type: "user", text: "", rendered: "{}" })).toBe(false);
  });
});
