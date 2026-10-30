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

/** One sidebar row: enough to recognize the session and know its state. */
export type SessionSummary = {
  sessionId: string;
  title?: string | null;
  watermark: number;
  eventCount: number;
  /** The last journaled event's type, or null when only a dispatch exists. */
  lastEventType: string | null;
  /** When the tail was observed, for ordering; 0 when only a dispatch exists. */
  lastIngestedAt: number;
  /** True while the session holds an active run. */
  live: boolean;
  /**
   * The session's pin (§2.3, ADR-006), or null for a session dispatched before
   * the pin milestone. Nullable is the honest answer: the panel says "workspace
   * unknown for this session" rather than guessing where it runs.
   */
  runnerId: string | null;
  workspaceId: string | null;
  /**
   * The SDK session id to resume (§10.4), extracted from the session.updated
   * event payload. Null when not yet observed.
   */
  sdkSessionId: string | null;
};

/**
 * The owner's sessions, most recently active first (§16.1's sidebar).
 *
 * A session appears either because the journal holds its events or because a
 * dispatched run is in flight — a run that has not produced its first event
 * yet is exactly the one the owner wants listed.
 */
export function listSessions(db: Database, ownerId: string): SessionSummary[] {
  const rows = db
    .prepare(
      `SELECT e.session_id AS session_id,
              MAX(e.session_sequence) AS watermark,
              COUNT(*) AS event_count,
              MAX(e.ingested_at) AS last_ingested_at,
              (a.session_id IS NOT NULL) AS live,
              s.runner_id AS runner_id,
              s.workspace_id AS workspace_id,
              s.title AS title
       FROM run_events e
       JOIN runners r ON r.id = e.runner_id
       LEFT JOIN active_runs a ON a.session_id = e.session_id
       LEFT JOIN sessions s ON s.id = e.session_id
       WHERE r.owner_id = ?
       GROUP BY e.session_id`,
    )
    .all(ownerId) as Array<{
    session_id: string;
    watermark: number;
    event_count: number;
    last_ingested_at: number;
    live: number;
    runner_id: string | null;
    workspace_id: string | null;
    title: string | null;
  }>;

  const dispatched = db
    .prepare(
      `SELECT DISTINCT a.session_id AS session_id, a.dispatched_at AS dispatched_at,
              s.runner_id AS runner_id, s.workspace_id AS workspace_id, s.title AS title
       FROM active_runs a
       JOIN runners r ON r.id = a.runner_id
       LEFT JOIN sessions s ON s.id = a.session_id
       WHERE r.owner_id = ?`,
    )
    .all(ownerId) as Array<{
    session_id: string;
    dispatched_at: number;
    runner_id: string | null;
    workspace_id: string | null;
    title: string | null;
  }>;

  const byId = new Map<string, SessionSummary>();
  for (const row of rows) {
    byId.set(row.session_id, {
      sessionId: row.session_id,
      title: row.title ?? undefined,
      watermark: row.watermark,
      eventCount: row.event_count,
      lastEventType: null,
      lastIngestedAt: row.last_ingested_at,
      live: row.live === 1,
      runnerId: row.runner_id,
      workspaceId: row.workspace_id,
      sdkSessionId: null,
    });
  }
  for (const row of dispatched) {
    if (byId.has(row.session_id)) continue;
    byId.set(row.session_id, {
      sessionId: row.session_id,
      title: row.title ?? undefined,
      watermark: 0,
      eventCount: 0,
      lastEventType: null,
      lastIngestedAt: row.dispatched_at,
      live: true,
      runnerId: row.runner_id,
      workspaceId: row.workspace_id,
      sdkSessionId: null,
    });
  }

  // The tail's type needs the row itself, so it is a second pass per session —
  // a sidebar is a handful of rows, not a transcript.
  const summaries = [...byId.values()];
  for (const summary of summaries) {
    if (summary.eventCount === 0) continue;
    const tail = db
      .prepare(
        "SELECT type FROM run_events WHERE session_id = ? ORDER BY session_sequence DESC LIMIT 1",
      )
      .get(summary.sessionId) as { type: string } | null;
    summary.lastEventType = tail?.type ?? null;

    // Extract the SDK session id from the most recent session.updated event,
    // if any. The payload is { sdkSessionId?: string }.
    const updated = db
      .prepare(
        "SELECT payload FROM run_events WHERE session_id = ? AND type = 'session.updated' ORDER BY session_sequence DESC LIMIT 1",
      )
      .get(summary.sessionId) as { payload: string } | null;
    if (updated !== null) {
      try {
        const parsed = JSON.parse(updated.payload) as Record<string, unknown>;
        const id = parsed["sdkSessionId"];
        if (typeof id === "string" && id !== "") {
          summary.sdkSessionId = id;
        }
      } catch {
        // Malformed payload — leave null.
      }
    }
  }

  return summaries.sort((a, b) => b.lastIngestedAt - a.lastIngestedAt);
}
