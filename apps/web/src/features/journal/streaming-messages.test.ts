import { describe, expect, test } from "bun:test";
import type { BrowserReplayEvent } from "@cc-web/protocol";
import { deriveJournalRows } from "./streaming-messages.ts";

let seq = 0;
function event(type: string, payload: unknown, runId = "run-1"): BrowserReplayEvent {
  seq += 1;
  return {
    sessionSequence: seq,
    eventId: `evt-${seq}`,
    runId,
    attemptId: "attempt-1",
    occurredAt: "2026-10-25T00:00:00Z",
    type: type as BrowserReplayEvent["type"],
    payload,
  };
}

function reset(): void {
  seq = 0;
}

function streamingRows(rows: ReturnType<typeof deriveJournalRows>) {
  return rows.filter((row) => row.kind === "streaming");
}

function toolRows(rows: ReturnType<typeof deriveJournalRows>) {
  return rows.filter((row) => row.kind === "tool");
}

/** A `message.completed` payload in the executor's redacted SDKAssistantMessage shape. */
function completedWith(content: unknown[]): BrowserReplayEvent {
  return event("message.completed", {
    type: "assistant",
    message: { id: "msg_1", content, model: "m" },
    parent_tool_use_id: null,
  });
}

describe("deriveJournalRows", () => {
  test("run headers appear when the run changes", () => {
    reset();
    const rows = deriveJournalRows([event("run.started", {}), event("run.finished", {}, "run-2")]);
    expect(
      rows.filter((row) => row.kind === "run").map((row) => (row as { runId: string }).runId),
    ).toEqual(["run-1", "run-2"]);
  });

  test("started and delta rows are hidden; completed renders and closes the entry", () => {
    reset();
    const rows = deriveJournalRows([
      event("message.started", { messageId: "msg_1" }),
      event("message.delta", { messageId: "msg_1", text: "Hel" }),
      event("message.delta", { messageId: "msg_1", text: "lo" }),
      event("message.completed", { id: "msg_1", content: [] }),
    ]);
    expect(streamingRows(rows)).toEqual([]);
    expect(
      rows
        .filter((row) => row.kind === "event")
        .map((row) => (row as { event: BrowserReplayEvent }).event.type),
    ).toEqual(["message.completed"]);
  });

  test("the executor's real completed shape (redacted SDKAssistantMessage) closes the entry", () => {
    // The executor persists redactSdkMessage(assistantFrame): the id lives at
    // payload.message.id, not payload.id (SDKAssistantMessage has no top-level
    // id). A completed payload shaped any other way must not strand the open
    // streaming entry as a forever-"interrupted" duplicate.
    reset();
    const rows = deriveJournalRows([
      event("message.started", { messageId: "msg_1" }),
      event("message.delta", { messageId: "msg_1", text: "Hel" }),
      event("message.delta", { messageId: "msg_1", text: "lo" }),
      event("message.completed", {
        type: "assistant",
        message: { id: "msg_1", content: [{ type: "text", text: "Hello" }], model: "m" },
        parent_tool_use_id: null,
      }),
    ]);
    expect(streamingRows(rows)).toEqual([]);
    expect(
      rows
        .filter((row) => row.kind === "event")
        .map((row) => (row as { event: BrowserReplayEvent }).event.type),
    ).toEqual(["message.completed"]);
  });

  test("open deltas render one streaming row inline with accumulated text", () => {
    reset();
    const rows = deriveJournalRows([
      event("message.started", { messageId: "msg_1" }),
      event("message.delta", { messageId: "msg_1", text: "Hel" }),
      event("message.delta", { messageId: "msg_1", text: "lo" }),
    ]);
    expect(streamingRows(rows)).toEqual([
      {
        kind: "streaming",
        key: "streaming-msg_1",
        messageId: "msg_1",
        text: "Hello",
        lastSequence: 3,
        interrupted: false,
      },
    ]);
  });

  test("a run terminal mid-stream leaves the partial as interrupted", () => {
    reset();
    const rows = deriveJournalRows([
      event("message.started", { messageId: "msg_1" }),
      event("message.delta", { messageId: "msg_1", text: "partial" }),
      event("run.interrupted", {}),
    ]);
    expect(streamingRows(rows)).toEqual([
      {
        kind: "streaming",
        key: "streaming-msg_1",
        messageId: "msg_1",
        text: "partial",
        lastSequence: 2,
        interrupted: true,
      },
    ]);
  });

  test("a delta without a started message is ignored", () => {
    reset();
    const rows = deriveJournalRows([
      event("message.delta", { messageId: "msg_x", text: "orphan" }),
    ]);
    expect(streamingRows(rows)).toEqual([]);
    expect(rows.filter((row) => row.kind === "event")).toHaveLength(0);
  });

  test("completed for an unknown id is just the event row", () => {
    reset();
    const rows = deriveJournalRows([event("message.completed", { id: "msg_never_seen" })]);
    expect(streamingRows(rows)).toEqual([]);
    expect(rows.filter((row) => row.kind === "event")).toHaveLength(1);
  });

  test("started and completed with no deltas is just the event row", () => {
    reset();
    const rows = deriveJournalRows([
      event("message.started", { messageId: "msg_1" }),
      event("message.completed", { id: "msg_1" }),
    ]);
    expect(streamingRows(rows)).toEqual([]);
    expect(rows.filter((row) => row.kind === "event")).toHaveLength(1);
  });

  test("a delta following its own completed reopens the entry (observed SDK ordering)", () => {
    // The compiled-binary probe showed the SDK can emit a complete assistant
    // message before the text deltas of the same message id. The transcript
    // must stream that text too, and the final completed closes it again.
    reset();
    const prefix = [
      event("message.started", { messageId: "msg_1" }),
      event("message.completed", { id: "msg_1" }),
      event("message.delta", { messageId: "msg_1", text: "OK" }),
    ];
    const mid = deriveJournalRows(prefix);
    expect(streamingRows(mid)).toEqual([
      {
        kind: "streaming",
        key: "streaming-msg_1",
        messageId: "msg_1",
        text: "OK",
        lastSequence: 3,
        interrupted: false,
      },
    ]);
    const rows = deriveJournalRows([...prefix, event("message.completed", { id: "msg_1" })]);
    expect(streamingRows(rows)).toEqual([]);
    expect(rows.filter((row) => row.kind === "event")).toHaveLength(2);
  });

  test("interleaved messages keep their texts separate", () => {
    reset();
    const rows = deriveJournalRows([
      event("message.started", { messageId: "msg_a" }),
      event("message.delta", { messageId: "msg_a", text: "AAA" }),
      event("message.started", { messageId: "msg_b" }),
      event("message.delta", { messageId: "msg_b", text: "BBB" }),
      event("message.completed", { id: "msg_a" }),
      event("message.delta", { messageId: "msg_b", text: "!" }),
    ]);
    const open = streamingRows(rows);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ messageId: "msg_b", text: "BBB!" });
  });

  test("derivation is deterministic: same events, same rows", () => {
    reset();
    const events = [
      event("message.started", { messageId: "msg_1" }),
      event("message.delta", { messageId: "msg_1", text: "hi" }),
      event("run.interrupted", {}),
    ];
    expect(deriveJournalRows(events)).toEqual(deriveJournalRows([...events]));
  });

  test("malformed payloads are ignored", () => {
    reset();
    const rows = deriveJournalRows([
      event("message.started", {}),
      event("message.started", { messageId: 42 }),
      event("message.delta", { messageId: "msg_1" }),
      event("message.delta", { messageId: "msg_1", text: 7 }),
      event("message.delta", { text: "no id" }),
      event("run.finished", {}),
    ]);
    expect(streamingRows(rows)).toEqual([]);
  });

  test("a started and completed tool pair renders one settled row", () => {
    reset();
    const rows = deriveJournalRows([
      event("tool.started", { toolCallId: "toolu-1", toolName: "Bash" }),
      event("tool.completed", { toolCallId: "toolu-1", isError: false, outputSummary: "hi" }),
    ]);
    expect(toolRows(rows)).toEqual([
      {
        kind: "tool",
        key: "tool-toolu-1",
        toolCallId: "toolu-1",
        toolName: "Bash",
        state: "done",
        outputSummary: "hi",
        inputSummary: null,
        lastSequence: 2,
      },
    ]);
    expect(rows.filter((row) => row.kind === "event")).toHaveLength(0);
  });

  test("an in-flight tool renders one running row in the live tail", () => {
    reset();
    const rows = deriveJournalRows([
      event("tool.started", { toolCallId: "toolu-1", toolName: "Bash" }),
    ]);
    expect(toolRows(rows)).toEqual([
      {
        kind: "tool",
        key: "tool-toolu-1",
        toolCallId: "toolu-1",
        toolName: "Bash",
        state: "running",
        outputSummary: null,
        inputSummary: null,
        lastSequence: 1,
      },
    ]);
  });

  test("an error completion settles the row as error", () => {
    reset();
    const rows = deriveJournalRows([
      event("tool.started", { toolCallId: "toolu-1", toolName: "Bash" }),
      event("tool.completed", { toolCallId: "toolu-1", isError: true, outputSummary: "boom" }),
    ]);
    expect(toolRows(rows)[0]).toMatchObject({ state: "error", outputSummary: "boom" });
  });

  test("a run terminal mid-tool marks the row interrupted", () => {
    reset();
    const rows = deriveJournalRows([
      event("tool.started", { toolCallId: "toolu-1", toolName: "Bash" }),
      event("run.interrupted", {}),
    ]);
    expect(toolRows(rows)[0]).toMatchObject({ state: "interrupted" });
  });

  test("a completed for an unknown id renders a settled row with no name", () => {
    reset();
    const rows = deriveJournalRows([
      event("tool.completed", { toolCallId: "toolu-x", isError: false }),
    ]);
    expect(toolRows(rows)).toEqual([
      {
        kind: "tool",
        key: "tool-toolu-x",
        toolCallId: "toolu-x",
        toolName: null,
        state: "done",
        outputSummary: null,
        inputSummary: null,
        lastSequence: 1,
      },
    ]);
  });

  test("a late started after completion fills the name without reopening", () => {
    // The SDK ordering quirk observed with text applies to tools too: the
    // complete frames can precede their own raw stream events. A settled row
    // gains the name and keeps its settled position.
    reset();
    const rows = deriveJournalRows([
      event("tool.completed", { toolCallId: "toolu-1", isError: false, outputSummary: "hi" }),
      event("tool.started", { toolCallId: "toolu-1", toolName: "Bash" }),
    ]);
    expect(toolRows(rows)).toEqual([
      {
        kind: "tool",
        key: "tool-toolu-1",
        toolCallId: "toolu-1",
        toolName: "Bash",
        state: "done",
        outputSummary: "hi",
        inputSummary: null,
        lastSequence: 1,
      },
    ]);
  });

  test("a tool_use in a completed message attaches its input to the tool row", () => {
    // The summary attaches without disturbing the row: state stays running and
    // lastSequence stays at the tool's own last event, not the message's.
    reset();
    const rows = deriveJournalRows([
      event("tool.started", { toolCallId: "toolu-1", toolName: "Bash" }),
      completedWith([{ type: "tool_use", id: "toolu-1", name: "Bash", input: { command: "ls" } }]),
    ]);
    expect(toolRows(rows)[0]).toMatchObject({
      state: "running",
      inputSummary: '{"command":"ls"}',
      lastSequence: 1,
    });
  });

  test("the input summary lands even when the completed message precedes the raw start", () => {
    // The complete-before-raw SDK ordering quirk: the message carrying the
    // tool_use arrives before tool.started. The final attachment pass makes the
    // summary order-independent.
    reset();
    const rows = deriveJournalRows([
      completedWith([{ type: "tool_use", id: "toolu-1", name: "Bash", input: { command: "ls" } }]),
      event("tool.started", { toolCallId: "toolu-1", toolName: "Bash" }),
      event("tool.completed", { toolCallId: "toolu-1", isError: false }),
    ]);
    expect(toolRows(rows)[0]).toMatchObject({ inputSummary: '{"command":"ls"}', lastSequence: 3 });
  });

  test("an oversized input is capped at 240 characters plus an ellipsis", () => {
    reset();
    const rows = deriveJournalRows([
      event("tool.started", { toolCallId: "toolu-1", toolName: "Bash" }),
      completedWith([
        { type: "tool_use", id: "toolu-1", name: "Bash", input: { command: "x".repeat(300) } },
      ]),
    ]);
    const summary = toolRows(rows)[0]?.inputSummary;
    expect(summary).toHaveLength(241);
    expect(summary?.endsWith("…")).toBe(true);
  });

  test("a tool_use without a usable input leaves the summary null", () => {
    reset();
    const rows = deriveJournalRows([
      event("tool.started", { toolCallId: "toolu-1", toolName: "Bash" }),
      completedWith([{ type: "tool_use", id: "toolu-1", name: "Bash" }]),
      event("tool.started", { toolCallId: "toolu-2", toolName: "Read" }),
      completedWith([{ type: "tool_use", id: "toolu-2", name: "Read", input: undefined }]),
    ]);
    expect(toolRows(rows)[0]?.inputSummary).toBe(null);
    expect(toolRows(rows)[1]?.inputSummary).toBe(null);
  });

  test("tool_use blocks without a usable id are skipped", () => {
    reset();
    const rows = deriveJournalRows([
      event("tool.started", { toolCallId: "toolu-1", toolName: "Bash" }),
      completedWith([
        { type: "tool_use", name: "NoId", input: { a: 1 } },
        { type: "tool_use", id: "", name: "Empty", input: { a: 1 } },
        { type: "tool_use", id: "toolu-1", name: "Bash", input: { command: "ls" } },
        { type: "text", text: "hi" },
      ]),
    ]);
    expect(toolRows(rows)[0]?.inputSummary).toBe('{"command":"ls"}');
  });

  test("malformed tool payloads are ignored", () => {
    reset();
    const rows = deriveJournalRows([
      event("tool.started", { toolCallId: 42, toolName: "Bash" }),
      event("tool.started", {}),
      event("tool.completed", { isError: false }),
      event("run.finished", {}),
    ]);
    expect(toolRows(rows)).toEqual([]);
  });

  test("two tool calls render two rows in started order", () => {
    reset();
    const rows = deriveJournalRows([
      event("tool.started", { toolCallId: "toolu-1", toolName: "Bash" }),
      event("tool.started", { toolCallId: "toolu-2", toolName: "Read" }),
      event("tool.completed", { toolCallId: "toolu-1", isError: false }),
      event("tool.completed", { toolCallId: "toolu-2", isError: false }),
    ]);
    expect(toolRows(rows).map((row) => (row as { toolCallId: string }).toolCallId)).toEqual([
      "toolu-1",
      "toolu-2",
    ]);
  });

  test("a settled tool row sits inline between the surrounding events", () => {
    reset();
    const rows = deriveJournalRows([
      event("run.started", {}),
      event("tool.started", { toolCallId: "toolu-1", toolName: "Bash" }),
      event("tool.completed", { toolCallId: "toolu-1", isError: false }),
      event("run.finished", {}),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["run", "event", "tool", "event"]);
  });

  test("entries of a later run place after that run's header, never above it", () => {
    // Pins the header-sequence restructure: a run header used to carry
    // MAX_SAFE_INTEGER as its scan boundary, so an open entry of the run the
    // header belongs to flushed ABOVE its own header. Two runs make the
    // regression shape explicit — run B's header, then run B's live tail.
    reset();
    const rows = deriveJournalRows([
      event("run.started", {}, "run-1"),
      event("run.finished", {}, "run-1"),
      event("run.started", {}, "run-2"),
      event("tool.started", { toolCallId: "toolu-9", toolName: "Bash" }, "run-2"),
      event("message.started", { messageId: "msg_9" }, "run-2"),
      event("message.delta", { messageId: "msg_9", text: "hi" }, "run-2"),
    ]);
    expect(rows.map((row) => row.kind)).toEqual([
      "run",
      "event",
      "event",
      "run",
      "event",
      "streaming",
      "tool",
    ]);
  });
});
