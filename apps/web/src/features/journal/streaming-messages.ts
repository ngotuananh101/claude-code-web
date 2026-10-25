import type { BrowserReplayEvent } from "@cc-web/protocol";

/**
 * Journal rows for the browser transcript (§12.3, §12.5).
 *
 * The event list is the durable transcript; this derivation is the only place
 * that decides what the operator sees. `message.started` and `message.delta`
 * rows never render as rows — deltas accumulate into one streaming entry per
 * SDK message id, placed inline at the position of the message's last delta
 * and closed by the `message.completed` that carries the same id. A run
 * terminal that arrives mid-stream leaves the partial text as an interrupted
 * entry: the run's outcome is real, and so is the text that preceded it.
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
    };

type StreamEntry = {
  messageId: string;
  text: string;
  lastSequence: number;
  interrupted: boolean;
};

const RUN_TERMINALS = new Set(["run.finished", "run.failed", "run.interrupted"]);

/** Payload readers that refuse anything but the documented shapes (§12.4). */
function messageIdOf(payload: unknown): string | undefined {
  const id = (payload as Record<string, unknown> | null)?.["messageId"];
  return typeof id === "string" && id !== "" ? id : undefined;
}

export function deriveJournalRows(events: readonly BrowserReplayEvent[]): JournalRow[] {
  const rows: JournalRow[] = [];
  const open = new Map<string, StreamEntry>();
  const completed = new Set<string>();
  let lastRun: string | null = null;

  for (const event of events) {
    if (event.runId !== lastRun) {
      rows.push({ kind: "run", runId: event.runId, key: `run-${event.runId}` });
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

    if (event.type === "message.completed") {
      const id = (event.payload as Record<string, unknown> | null)?.["id"];
      if (typeof id === "string") {
        open.delete(id);
        completed.add(id);
      }
      rows.push({ kind: "event", event });
      continue;
    }

    if (RUN_TERMINALS.has(event.type)) {
      for (const entry of open.values()) entry.interrupted = true;
      rows.push({ kind: "event", event });
      continue;
    }

    rows.push({ kind: "event", event });
  }

  // Streaming entries sit inline at the position of their last delta: every
  // event with a smaller sequence has already been emitted above, so flushing
  // each open entry the first time the scan passes its lastSequence places it
  // between the surrounding visible rows. Entries left open by the end of the
  // transcript (a run still streaming) land after the last row — the live tail.
  const placed = new Set<string>();
  const out: JournalRow[] = [];
  for (const row of rows) {
    const sequence = row.kind === "event" ? row.event.sessionSequence : Number.MAX_SAFE_INTEGER;
    for (const [id, entry] of open) {
      if (!placed.has(id) && entry.lastSequence < sequence) {
        placed.add(id);
        out.push(streamingRow(entry));
      }
    }
    out.push(row);
  }
  for (const [id, entry] of open) {
    if (!placed.has(id)) out.push(streamingRow(entry));
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
