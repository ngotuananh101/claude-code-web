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
});
