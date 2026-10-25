import type { BrowserReplayEvent } from "@cc-web/protocol";

/**
 * Journal rows for the browser transcript (§12.3, §12.5).
 *
 * The event list is the durable transcript; this derivation is the only place
 * that decides what the operator sees. `message.started` and `message.delta`
 * rows never render as rows — deltas accumulate into one streaming entry per
 * SDK message id, placed inline at the position of the message's last delta
 * and closed by the `message.completed` that carries the same id. Tool calls
 * pair the same way: `tool.started` and `tool.completed` collapse into one row
 * per call id that settles when the tool returns. A run terminal that arrives
 * mid-stream leaves the partial text and the in-flight tool as interrupted
 * rows: the run's outcome is real, and so is the work that preceded it.
 *
 * Pure and deterministic — replaying the same events always produces the same
 * rows, which is what makes a resubscribed client's transcript identical to a
 * live one.
 */

export type JournalRow =
  | { kind: "run"; runId: string; key: string }
  | { kind: "event"; event: BrowserReplayEvent }
  | {
      kind: "streaming";
      key: string;
      messageId: string;
      text: string;
      lastSequence: number;
      interrupted: boolean;
    }
  | {
      kind: "tool";
      key: string;
      toolCallId: string;
      toolName: string | null;
      state: "running" | "done" | "error" | "interrupted";
      outputSummary: string | null;
      lastSequence: number;
    };

type StreamEntry = {
  messageId: string;
  text: string;
  lastSequence: number;
  interrupted: boolean;
};

type ToolEntry = {
  toolCallId: string;
  toolName: string | null;
  state: "running" | "done" | "error" | "interrupted";
  outputSummary: string | null;
  lastSequence: number;
};

const RUN_TERMINALS = new Set(["run.finished", "run.failed", "run.interrupted"]);

/** Payload readers that refuse anything but the documented shapes (§12.4). */
function messageIdOf(payload: unknown): string | undefined {
  const id = (payload as Record<string, unknown> | null)?.["messageId"];
  return typeof id === "string" && id !== "" ? id : undefined;
}

function toolCallIdOf(payload: unknown): string | undefined {
  const id = (payload as Record<string, unknown> | null)?.["toolCallId"];
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * The completed event persists the redacted SDKAssistantMessage, which has no
 * top-level id — the message id lives at `message.id`. The direct `id` read is
 * a fallback for journal rows written before this shape was pinned, not the
 * primary: reading it first would strand real runs' streaming entries open.
 */
function completedMessageIdOf(payload: unknown): string | undefined {
  const record = payload as Record<string, unknown> | null;
  if (record === null || typeof record !== "object") return undefined;
  const nested = (record["message"] as Record<string, unknown> | null)?.["id"];
  if (typeof nested === "string" && nested !== "") return nested;
  const direct = record["id"];
  return typeof direct === "string" && direct !== "" ? direct : undefined;
}

export function deriveJournalRows(events: readonly BrowserReplayEvent[]): JournalRow[] {
  // Visible rows in emit order, each tagged with the sequence of the event
  // that produced it. A run header carries its trigger event's sequence, not
  // infinity: an open entry must place after the header of the run it belongs
  // to, and before the first event of the next one.
  const pending: Array<{ row: JournalRow; sequence: number }> = [];
  const open = new Map<string, StreamEntry>();
  const completed = new Set<string>();
  const tools = new Map<string, ToolEntry>();
  let lastRun: string | null = null;

  for (const event of events) {
    if (event.runId !== lastRun) {
      pending.push({
        row: { kind: "run", runId: event.runId, key: `run-${event.runId}` },
        sequence: event.sessionSequence,
      });
      lastRun = event.runId;
    }

    if (event.type === "message.started") {
      const id = messageIdOf(event.payload);
      if (id !== undefined)
        open.set(id, {
          messageId: id,
          text: "",
          lastSequence: event.sessionSequence,
          interrupted: false,
        });
      continue;
    }

    if (event.type === "message.delta") {
      const id = messageIdOf(event.payload);
      const text = (event.payload as Record<string, unknown> | null)?.["text"];
      if (typeof text !== "string" || id === undefined) continue;
      // The SDK can emit a message's complete frame before its own text deltas
      // (observed from the compiled binary). A delta for an id the transcript
      // already completed reopens the entry — the following completed for that
      // id closes it again; a delta for a truly unknown id stays ignored.
      const entry =
        open.get(id) ??
        (completed.has(id)
          ? { messageId: id, text: "", lastSequence: event.sessionSequence, interrupted: false }
          : undefined);
      if (entry === undefined) continue;
      entry.text += text;
      entry.lastSequence = event.sessionSequence;
      open.set(id, entry);
      continue;
    }

    if (event.type === "tool.started") {
      const id = toolCallIdOf(event.payload);
      if (id === undefined) continue;
      const name = (event.payload as Record<string, unknown> | null)?.["toolName"];
      const entry = tools.get(id);
      if (entry === undefined) {
        tools.set(id, {
          toolCallId: id,
          toolName: typeof name === "string" && name !== "" ? name : null,
          state: "running",
          outputSummary: null,
          lastSequence: event.sessionSequence,
        });
      } else {
        // A late started for an id a completion already settled (the SDK can
        // emit complete frames before their own raw events) only fills the
        // name — a settled row keeps its position and state.
        if (typeof name === "string" && name !== "") entry.toolName = name;
        if (entry.state === "running") entry.lastSequence = event.sessionSequence;
      }
      continue;
    }

    if (event.type === "tool.completed") {
      const id = toolCallIdOf(event.payload);
      if (id === undefined) continue;
      const payload = event.payload as Record<string, unknown> | null;
      const summary = payload?.["outputSummary"];
      const entry = tools.get(id) ?? {
        toolCallId: id,
        toolName: null,
        state: "running" as const,
        outputSummary: null,
        lastSequence: event.sessionSequence,
      };
      entry.state = payload?.["isError"] === true ? "error" : "done";
      entry.outputSummary = typeof summary === "string" && summary !== "" ? summary : null;
      entry.lastSequence = event.sessionSequence;
      tools.set(id, entry);
      continue;
    }

    if (event.type === "message.completed") {
      const id = completedMessageIdOf(event.payload);
      if (id !== undefined) {
        open.delete(id);
        completed.add(id);
      }
      pending.push({ row: { kind: "event", event }, sequence: event.sessionSequence });
      continue;
    }

    if (RUN_TERMINALS.has(event.type)) {
      for (const entry of open.values()) entry.interrupted = true;
      for (const entry of tools.values()) {
        if (entry.state === "running") entry.state = "interrupted";
      }
      pending.push({ row: { kind: "event", event }, sequence: event.sessionSequence });
      continue;
    }

    pending.push({ row: { kind: "event", event }, sequence: event.sessionSequence });
  }

  // Streaming and tool entries sit inline at the position of their last
  // change: every event with a smaller sequence has already been emitted
  // above, so flushing each open entry the first time the scan passes its
  // lastSequence places it between the surrounding visible rows. Entries left
  // open by the end of the transcript (a run still streaming) land after the
  // last row — the live tail.
  const placedStreams = new Set<string>();
  const placedTools = new Set<string>();
  const out: JournalRow[] = [];
  for (const { row, sequence } of pending) {
    for (const [id, entry] of open) {
      if (!placedStreams.has(id) && entry.lastSequence < sequence) {
        placedStreams.add(id);
        out.push(streamingRow(entry));
      }
    }
    for (const [id, entry] of tools) {
      if (!placedTools.has(id) && entry.lastSequence < sequence) {
        placedTools.add(id);
        out.push(toolRow(entry));
      }
    }
    out.push(row);
  }
  for (const [id, entry] of open) {
    if (!placedStreams.has(id)) out.push(streamingRow(entry));
  }
  for (const [id, entry] of tools) {
    if (!placedTools.has(id)) out.push(toolRow(entry));
  }
  return out;
}

function streamingRow(entry: StreamEntry): JournalRow {
  return {
    kind: "streaming",
    key: `streaming-${entry.messageId}`,
    messageId: entry.messageId,
    text: entry.text,
    lastSequence: entry.lastSequence,
    interrupted: entry.interrupted,
  };
}

function toolRow(entry: ToolEntry): JournalRow {
  return {
    kind: "tool",
    key: `tool-${entry.toolCallId}`,
    toolCallId: entry.toolCallId,
    toolName: entry.toolName,
    state: entry.state,
    outputSummary: entry.outputSummary,
    lastSequence: entry.lastSequence,
  };
}
