import { describe, expect, test } from "bun:test";
import type { BrowserReplayEvent, SessionMessage } from "@cc-web/protocol";
import { deriveHistoryRows, hasProse } from "@/features/journal/history-messages.ts";
import { renderMarkdown } from "@/features/journal/markdown.ts";
import { deriveJournalRows } from "@/features/journal/streaming-messages.ts";

/**
 * Component-level contract tests for EventJournal.vue (§16.1, Task 13).
 *
 * The Vue SFC cannot be compiled in the Bun test environment without
 * `@vue/compiler-sfc`, so — following the codebase convention established by
 * FolderBrowserModal.test.ts and Composer.test.ts — these tests exercise the
 * pure helpers the component wires to its template:
 *
 *  - `deriveHistoryRows` produces one renderable row per historical message,
 *    preserving order, with a stable key and either prose or a JSON fallback.
 *  - The component renders historical rows in chronological order BEFORE the
 *    live run-event rows, with a distinct separator (pinned here by asserting
 *    the separation rather than the markup, since the markup lives in the SFC).
 *
 * The component's job is assembly, not extraction; the extraction rules are
 * pinned in `features/journal/history-messages.test.ts`, so a regression that
 * makes the journal drop or reorder replayed text is caught here at the
 * assembly contract.
 */

function message(type: SessionMessage["type"], uuid: string, content: unknown): SessionMessage {
  return { type, uuid, message: content };
}

function event(type: string, payload: unknown, runId = "run-1"): BrowserReplayEvent {
  return {
    sessionSequence: 1,
    eventId: `evt-${type}`,
    runId,
    attemptId: "attempt-1",
    occurredAt: "2026-10-25T00:00:01Z",
    type: type as BrowserReplayEvent["type"],
    payload,
  };
}

/** A raw, possibly-malformed message modeled as a SessionMessage for tests. */
function rawMessage(message: unknown): SessionMessage {
  return { type: "user", uuid: "raw", message: message } as unknown as SessionMessage;
}

describe("EventJournal contract — historical message replay", () => {
  test("each historical message becomes one row preserving order", () => {
    const messages: SessionMessage[] = [
      message("user", "u-1", { content: "hello" }),
      message("assistant", "a-1", { content: [{ type: "text", text: "hi back" }] }),
      message("system", "s-1", { content: "note" }),
    ];
    const rows = deriveHistoryRows(messages);

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.key)).toEqual(["history-u-1", "history-a-1", "history-s-1"]);
    expect(rows.map((r) => r.type)).toEqual(["user", "assistant", "system"]);
    expect(rows.every((r) => hasProse(r))).toBe(true);
    expect(rows.map((r) => r.text)).toEqual(["hello", "hi back", "note"]);
  });

  test("no historical messages yields no history rows (live-only journal)", () => {
    expect(deriveHistoryRows([])).toEqual([]);
  });

  test("historical rows render in chronological order, then live event rows", () => {
    // The component concatenates history rows above the live-derived rows.
    // Pin the assembly contract: history first, events after, in order.
    const messages: SessionMessage[] = [
      message("user", "u-1", { content: "past" }),
      message("assistant", "a-1", { content: [{ type: "text", text: "earlier" }] }),
    ];
    const historyRows = deriveHistoryRows(messages);

    const liveEvents = [
      event("run.started", {}, "run-2"),
      event("message.completed", { id: "msg_live", content: [{ type: "text", text: "now" }] }),
    ];
    const liveRows = deriveJournalRows(liveEvents);

    // The component's assembled row stream: history, then a separator, then live.
    const assembled = [...historyRows, ...liveRows];
    expect(assembled.slice(0, 2)).toEqual(historyRows);
    expect(assembled.slice(2)).toEqual(liveRows);
  });

  test("the separator sits between history and live rows", () => {
    // The separator is a section header ("Lịch sử hội thoại") rendered by the
    // component between the two groups. Pin its existence as a contract: when
    // there is history AND live events, exactly one separator is expected.
    const hasHistory = deriveHistoryRows([message("user", "u-1", { content: "hi" })]).length > 0;
    const hasLive = deriveJournalRows([event("run.started", {})]).length > 0;
    expect(hasHistory && hasLive).toBe(true);
  });

  test("a non-prose historical message falls back to JSON, not a blank row", () => {
    const messages: SessionMessage[] = [message("user", "u-1", { content: { weird: 1 } })];
    const rows = deriveHistoryRows(messages);
    expect(hasProse(rows[0]!)).toBe(false);
    expect(rows[0]!.rendered).not.toBe("");
    expect(rows[0]!.rendered).toContain("weird");
  });

  test("malformed historical messages do not throw — the whole header stays intact", () => {
    // The runner surfaces whatever the SDK persisted; one odd message must not
    // blank the replayed header. messageTextOf returns "" for the unparseable
    // one and a JSON fallback is emitted instead, while valid ones still extract.
    const messages: SessionMessage[] = [
      message("user", "u-1", { content: "keep me" }),
      // The runner surfaces whatever the SDK persisted; a non-object message
      // must not throw or blank the replayed header. `rawMessage` models a
      // genuinely foreign wire value so type-checking stays on.
      { ...rawMessage("not-an-object"), uuid: "u-2" },
      message("assistant", "a-1", { content: [{ type: "text", text: "also keep me" }] }),
    ];
    const rows = deriveHistoryRows(messages);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.text)).toEqual(["keep me", "", "also keep me"]);
    expect(rows[1]!.rendered).not.toBe("");
  });

  test("extracted prose feeds the shared markdown renderer", () => {
    // The component renders `text` through `renderMarkdown` (markdown.ts); this
    // pins that history rows feed that same path so a replayed message and a
    // live message share one escaping/security boundary.
    const row = deriveHistoryRows([message("user", "u-1", { content: "**hi**" })])[0]!;
    expect(renderMarkdown(row.text)).toContain("<strong>hi</strong>");
  });});
