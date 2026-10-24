import type { Database } from "bun:sqlite";
import type { EventType } from "@cc-web/protocol";

/**
 * The browser's read model over the journal (§12.5).
 *
 * Everything here answers in `session_sequence`, the one coordinate system a
 * browser resumes in: ordered reads for replay, a watermark for "how far the
 * journal goes", and an earliest bound so a subscription whose offset points
 * into deleted history can be answered with `resync_required` instead of a
 * silently truncated stream.
 */

/** One journal event as the browser sees it. Control-plane identity (runner,
 * boot) is deliberately absent: replay is content, not topology. */
export type ReplayEvent = {
  sessionSequence: number;
  eventId: string;
  runId: string;
  attemptId: string;
  occurredAt: string;
  // The only writer of this table is the runner gateway, which refuses any
  // type not in the protocol's runtime list — so this is a fact about the
  // journal, not an assumption about input.
  type: EventType;
  payload: unknown;
};

/** The highest committed session sequence; 0 when the session is empty. */
export function sessionWatermark(db: Database, sessionId: string): number {
  const row = db
    .prepare("SELECT MAX(session_sequence) AS max FROM run_events WHERE session_id = ?")
    .get(sessionId) as { max: number | null };
  return row.max ?? 0;
}

/** The lowest surviving session sequence; 0 when the session is empty. */
export function sessionEarliest(db: Database, sessionId: string): number {
  const row = db
    .prepare("SELECT MIN(session_sequence) AS min FROM run_events WHERE session_id = ?")
    .get(sessionId) as { min: number | null };
  return row.min ?? 0;
}

/**
 * Events after `after`, in session order, at most `limit` of them — one replay
 * batch. Bounded because §12.6 refuses unbounded anything on a browser socket;
 * the caller chains batches until a short one arrives.
 */
export function readSessionEvents(
  db: Database,
  sessionId: string,
  options: { after: number; limit?: number },
): ReplayEvent[] {
  const limit = options.limit ?? 200;
  const rows = db
    .prepare(
      `SELECT session_sequence, event_id, run_id, attempt_id, occurred_at, type, payload
       FROM run_events
       WHERE session_id = ? AND session_sequence > ?
       ORDER BY session_sequence
       LIMIT ?`,
    )
    .all(sessionId, options.after, limit) as Array<StoredRow>;

  return rows.map((row) => ({
    sessionSequence: row.session_sequence,
    eventId: row.event_id,
    runId: row.run_id,
    attemptId: row.attempt_id,
    occurredAt: row.occurred_at,
    // Text column, but its writer only ever stores protocol members (the
    // gateway refuses invented types at ingest), so the cast is a restatement
    // of an invariant, not a hope.
    type: row.type as EventType,
    payload: JSON.parse(row.payload),
  }));
}

type StoredRow = {
  session_sequence: number;
  event_id: string;
  run_id: string;
  attempt_id: string;
  occurred_at: string;
  type: string;
  payload: string;
};

/**
 * Whose session this is, or undefined if the server has never heard of it.
 *
 * A session has no table of its own; ownership follows the runner that owns
 * its work. The journal is the authority once events exist, with the command
 * outbox and `active_runs` covering a subscription that arrives between
 * dispatch and the first journaled event.
 */
export function sessionOwner(db: Database, sessionId: string): string | undefined {
  const runnerRow = db
    .prepare(
      `SELECT r.owner_id AS owner_id
       FROM run_events e JOIN runners r ON r.id = e.runner_id
       WHERE e.session_id = ?
       LIMIT 1`,
    )
    .get(sessionId) as { owner_id: string } | null;

  if (runnerRow !== null) return runnerRow.owner_id;

  const outboxRow = db
    .prepare(
      `SELECT r.owner_id AS owner_id
       FROM command_outbox c JOIN runners r ON r.id = c.runner_id
       WHERE c.session_id = ?
       LIMIT 1`,
    )
    .get(sessionId) as { owner_id: string } | null;

  if (outboxRow !== null) return outboxRow.owner_id;

  const activeRow = db
    .prepare(
      `SELECT r.owner_id AS owner_id
       FROM active_runs a JOIN runners r ON r.id = a.runner_id
       WHERE a.session_id = ?
       LIMIT 1`,
    )
    .get(sessionId) as { owner_id: string } | null;

  return activeRow?.owner_id;
}
