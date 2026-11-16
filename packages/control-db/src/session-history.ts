import type { Database } from "bun:sqlite";
import {
  type BrowserReplayEvent,
  type EventType,
  isConversationReset,
  isThinkingTokenEstimate,
  type SessionHistoryPage,
} from "@cc-web/protocol";
import { cleanChatPrompt } from "@cc-web/shared";
import { JOURNAL_EVENT_SQL } from "./replay-filter.ts";

type State = {
  last_sequence: number;
  reset_sequence: number;
  agent_cursor: number | null;
  active: number;
  context: string;
};
type ProjectionEvent = BrowserReplayEvent & { sessionId: string };
const TERMINALS = new Set(["run.finished", "run.failed", "run.interrupted"]);
function record(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

function routed(payload: Record<string, unknown>): boolean {
  return ["parentToolUseId", "parent_tool_use_id", "agentId", "agent_id"].some(
    (key) => typeof payload[key] === "string" && payload[key] !== "",
  );
}
function activity(event: BrowserReplayEvent, payload: Record<string, unknown>): boolean {
  return (
    [
      "message.started",
      "message.delta",
      "message.completed",
      "tool.started",
      "approval.requested",
    ].includes(event.type) ||
    (event.type === "run.status" &&
      ["task_notification", "task_updated"].includes(String(payload["subtype"])))
  );
}

/** Transactional, idempotent projection. Raw identities and ACK positions never change. */
export function projectSessionHistory(db: Database, event: ProjectionEvent): void {
  const previous = db
    .query("SELECT * FROM session_history_state WHERE session_id = ?")
    .get(event.sessionId) as State | null;
  const state: State = previous ?? {
    last_sequence: 0,
    reset_sequence: 0,
    agent_cursor: null,
    active: 0,
    context: "[]",
  };
  if (event.sessionSequence <= state.last_sequence) return;
  const { sessionId, ...input } = event;
  const payload = record(event.payload);
  state.last_sequence = event.sessionSequence;
  if (isConversationReset(event)) {
    state.reset_sequence = event.sessionSequence;
    state.agent_cursor = null;
    state.active = 0;
    state.context = JSON.stringify([input]);
  } else if (event.type === "session.updated" && !routed(payload)) {
    const context = JSON.parse(state.context) as BrowserReplayEvent[];
    state.context = JSON.stringify([
      ...context.filter((event) => event.type !== "session.updated" || isConversationReset(event)),
      input,
    ]);
  } else if (!isThinkingTokenEstimate(event)) {
    if (event.type.startsWith("approval.") || event.type.startsWith("question.")) {
      const context = JSON.parse(state.context) as BrowserReplayEvent[];
      const id = payload["approvalId"] ?? payload["questionId"];
      const remaining = context.filter((item) => {
        const other = record(item.payload);
        return id === undefined || (other["approvalId"] ?? other["questionId"]) !== id;
      });
      if (event.type.endsWith(".requested")) remaining.push(input);
      state.context = JSON.stringify(remaining);
    }
    if (!routed(payload) && event.type === "run.started") {
      // A run whose prompt is only transport wrappers produces no user bubble in the
      // reducer, so it must not spend one of the twelve page slots either.
      if (typeof payload["prompt"] === "string" && cleanChatPrompt(payload["prompt"]) !== "") {
        const cursor = event.sessionSequence * 2;
        createTurn(db, sessionId, cursor, "user", state.reset_sequence);
        appendChunk(db, sessionId, cursor, input);
      }
      state.agent_cursor = event.sessionSequence * 2 + 1;
      createTurn(db, sessionId, state.agent_cursor, "agent", state.reset_sequence);
      state.active = 1;
    } else if (!routed(payload) && activity(event, payload) && !state.active) {
      state.agent_cursor = event.sessionSequence * 2 + 1;
      createTurn(db, sessionId, state.agent_cursor, "agent", state.reset_sequence);
      state.active = 1;
    }
    if (state.agent_cursor !== null) appendChunk(db, sessionId, state.agent_cursor, input);
    if (!routed(payload) && TERMINALS.has(event.type)) state.active = 0;
  }
  db.query(`INSERT INTO session_history_state
    (session_id, last_sequence, reset_sequence, agent_cursor, active, context)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
    last_sequence=excluded.last_sequence, reset_sequence=excluded.reset_sequence,
    agent_cursor=excluded.agent_cursor, active=excluded.active, context=excluded.context`).run(
    sessionId,
    state.last_sequence,
    state.reset_sequence,
    state.agent_cursor,
    state.active,
    state.context,
  );
}

function createTurn(
  db: Database,
  sessionId: string,
  cursor: number,
  kind: string,
  reset: number,
): void {
  db.query(
    "INSERT OR IGNORE INTO session_history_turns (session_id, cursor, kind, reset_sequence) VALUES (?, ?, ?, ?)",
  ).run(sessionId, cursor, kind, reset);
}

function appendChunk(
  db: Database,
  sessionId: string,
  cursor: number,
  event: BrowserReplayEvent,
): void {
  const previous = db
    .query(`SELECT chunk_index, event FROM session_history_chunks
    WHERE session_id = ? AND cursor = ? ORDER BY chunk_index DESC LIMIT 1`)
    .get(sessionId, cursor) as { chunk_index: number; event: string } | null;
  if (previous !== null && event.type === "message.delta") {
    const last = JSON.parse(previous.event) as BrowserReplayEvent;
    const payload = record(event.payload);
    const old = record(last.payload);
    const keys = ["messageId", "parentToolUseId", "parent_tool_use_id", "agentId", "agent_id"];
    if (
      last.type === "message.delta" &&
      typeof old["text"] === "string" &&
      typeof payload["text"] === "string" &&
      old["text"].length + payload["text"].length <= 16 * 1024 &&
      keys.every((key) => old[key] === payload[key])
    ) {
      last.payload = { ...old, text: old["text"] + payload["text"] };
      db.query(
        "UPDATE session_history_chunks SET event = ? WHERE session_id = ? AND cursor = ? AND chunk_index = ?",
      ).run(JSON.stringify(last), sessionId, cursor, previous.chunk_index);
      return;
    }
  }
  db.query(
    "INSERT INTO session_history_chunks (session_id, cursor, chunk_index, event) VALUES (?, ?, ?, ?)",
  ).run(sessionId, cursor, (previous?.chunk_index ?? -1) + 1, JSON.stringify(event));
}

/** Called only by the existing authorized session/runner deletion transactions. */
export function deleteSessionHistory(db: Database, sessionId: string): void {
  db.query("DELETE FROM session_history_chunks WHERE session_id = ?").run(sessionId);
  db.query("DELETE FROM session_history_turns WHERE session_id = ?").run(sessionId);
  db.query("DELETE FROM session_history_state WHERE session_id = ?").run(sessionId);
}

/** Read headers before payloads: no parsing or reduction of unrequested older pages. */
export function readSessionHistory(
  db: Database,
  sessionId: string,
  options: { before?: number; resetSequence?: number } = {},
): SessionHistoryPage {
  const state = db
    .query("SELECT * FROM session_history_state WHERE session_id = ?")
    .get(sessionId) as State | null;
  const resetSequence = state?.reset_sequence ?? 0;
  if (options.resetSequence !== undefined && options.resetSequence !== resetSequence)
    throw new Error("history_reset");
  const rows = db
    .query(`SELECT cursor, kind FROM session_history_turns
    WHERE session_id = ? AND reset_sequence = ? AND cursor < ? ORDER BY cursor DESC LIMIT 13`)
    .all(sessionId, resetSequence, options.before ?? Number.MAX_SAFE_INTEGER) as Array<{
    cursor: number;
    kind: "user" | "agent";
  }>;
  const turns = rows
    .slice(0, 12)
    .reverse()
    .map((row) => ({
      ...row,
      events: (
        db
          .query(
            `SELECT event FROM session_history_chunks WHERE session_id = ? AND cursor = ? ORDER BY chunk_index`,
          )
          .all(sessionId, row.cursor) as Array<{ event: string }>
      ).map((chunk) => JSON.parse(chunk.event) as BrowserReplayEvent),
    }));
  return {
    turns,
    before: turns[0]?.cursor ?? null,
    hasMore: rows.length > 12,
    resetSequence,
    watermark: state?.last_sequence ?? 0,
    context: JSON.parse(state?.context ?? "[]") as BrowserReplayEvent[],
  };
}

// Bump whenever stored turn/chunk/context semantics change. A version change
// rebuilds only this read model; the durable journal is never modified.
const SESSION_HISTORY_PROJECTION_VERSION = 1;

/** Version-gated rebuild, never executed by a page read or a current-version boot. */
export function backfillSessionHistory(db: Database): void {
  const tx = db.transaction(() => {
    const applied = db
      .query("SELECT version FROM session_history_projection WHERE id = 1")
      .get() as { version: number } | null;
    if (applied?.version === SESSION_HISTORY_PROJECTION_VERSION) return;

    // Unversioned state may encode old semantics, so its watermark cannot be
    // trusted for an incremental backfill. Deletes roll back with a failed rebuild.
    db.exec(`DELETE FROM session_history_chunks;
      DELETE FROM session_history_turns;
      DELETE FROM session_history_state;`);
    const rows = db
      .query(`SELECT * FROM run_events WHERE ${JOURNAL_EVENT_SQL}
      ORDER BY session_id, session_sequence`)
      .iterate() as Iterable<{
      session_id: string;
      session_sequence: number;
      event_id: string;
      run_id: string;
      attempt_id: string;
      occurred_at: string;
      type: string;
      payload: string;
    }>;
    for (const row of rows)
      projectSessionHistory(db, {
        sessionId: row.session_id,
        sessionSequence: row.session_sequence,
        eventId: row.event_id,
        runId: row.run_id,
        attemptId: row.attempt_id,
        occurredAt: row.occurred_at,
        type: row.type as EventType,
        payload: JSON.parse(row.payload),
      });
    // Cover filtered telemetry too, without overwriting reconstructed reset/context.
    db.exec(`INSERT INTO session_history_state (session_id, last_sequence, reset_sequence, agent_cursor, active, context)
      SELECT session_id, MAX(session_sequence), 0, NULL, 0, '[]' FROM run_events GROUP BY session_id
      ON CONFLICT(session_id) DO UPDATE SET last_sequence=excluded.last_sequence`);
    // The gate commits only with the complete projection, including its watermark.
    db.query(`INSERT INTO session_history_projection (id, version) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET version=excluded.version`).run(
      SESSION_HISTORY_PROJECTION_VERSION,
    );
  });
  tx.immediate();
}
