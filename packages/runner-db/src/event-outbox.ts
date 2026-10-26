import type { Database } from "bun:sqlite";

/**
 * Durable event outbox with a contiguous ACK watermark (§12.2, §18.3).
 *
 * The rule that matters: an ACK may only advance across a contiguous run of
 * sequences. If the server reports "I have up to 4" but sequence 3 was never
 * appended here, the watermark stops at 2 — otherwise the outbox would treat an
 * undelivered event as delivered and delete it.
 *
 * The watermark is not stored separately. It is derived from the acknowledged
 * rows, so a gap closing later naturally lets it jump forward with no extra
 * bookkeeping to keep in sync.
 */

export type AppendParams = {
  eventId: string;
  attemptId: string;
  localSequence: number;
  sessionId: string;
  runId: string;
  type: string;
  payload: unknown;
  occurredAt: string;
  now?: number;
};

export type AppendResult = { ok: true } | { ok: false; reason: "duplicate_sequence" };

export type PendingEvent = {
  eventId: string;
  attemptId: string;
  localSequence: number;
  sessionId: string;
  runId: string;
  type: string;
  payload: unknown;
  occurredAt: string;
};

export function appendEvent(db: Database, params: AppendParams): AppendResult {
  const now = params.now ?? Date.now();

  try {
    db.prepare(
      `INSERT INTO event_outbox
         (event_id, attempt_id, local_sequence, session_id, run_id, type, payload,
          occurred_at, created_at, acknowledged)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(
      params.eventId,
      params.attemptId,
      params.localSequence,
      params.sessionId,
      params.runId,
      params.type,
      JSON.stringify(params.payload ?? null),
      params.occurredAt,
      now,
    );
  } catch (error) {
    const message = (error as Error).message;
    if (/UNIQUE constraint failed/i.test(message)) {
      // A duplicate sequence is either our own bug or a conflicting sender.
      // Silently overwriting it would corrupt the transcript; report it.
      return { ok: false, reason: "duplicate_sequence" };
    }
    throw error;
  }

  return { ok: true };
}

/**
 * How many unacknowledged rows one `pendingEvents` call reads when the caller
 * does not say. The pump's frame ceiling is the number that matters; this
 * default only exists so the floor below is never an unbounded read.
 */
export const DEFAULT_PENDING_LIMIT = 64;

export function pendingEvents(
  db: Database,
  attemptId: string,
  params: { limit?: number } = {},
): PendingEvent[] {
  const rows = db
    .prepare(
      `SELECT event_id, attempt_id, local_sequence, session_id, run_id, type, payload, occurred_at
       FROM event_outbox
       WHERE attempt_id = ? AND acknowledged = 0
       ORDER BY local_sequence ASC
       LIMIT ?`,
    )
    .all(attemptId, params.limit ?? DEFAULT_PENDING_LIMIT) as Array<{
    event_id: string;
    attempt_id: string;
    local_sequence: number;
    session_id: string;
    run_id: string;
    type: string;
    payload: string;
    occurred_at: string;
  }>;

  return rows.map((row) => ({
    eventId: row.event_id,
    attemptId: row.attempt_id,
    localSequence: row.local_sequence,
    sessionId: row.session_id,
    runId: row.run_id,
    type: row.type,
    payload: JSON.parse(row.payload),
    occurredAt: row.occurred_at,
  }));
}

/**
 * Every attempt that still has an unacknowledged row, in stable id order.
 *
 * The sender asks this first — one query for "who has work?" instead of a
 * per-attempt row scan on every reconnect.
 */
export function pendingEventAttempts(db: Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT attempt_id FROM event_outbox WHERE acknowledged = 0 ORDER BY attempt_id`,
    )
    .all() as Array<{ attempt_id: string }>;
  return rows.map((row) => row.attempt_id);
}

/**
 * Acknowledge everything contiguous up to `sequence`.
 *
 * Returns the watermark actually reached, which may be lower than requested when
 * a gap exists. Callers must use the return value, not their own request.
 */
export function ackUpTo(
  db: Database,
  params: { attemptId: string; sequence: number },
): { ackedThrough: number } {
  const sequences = db
    .prepare(
      `SELECT local_sequence FROM event_outbox
       WHERE attempt_id = ? AND local_sequence <= ?
       ORDER BY local_sequence ASC`,
    )
    .all(params.attemptId, params.sequence) as Array<{ local_sequence: number }>;

  // Walk from 1 and stop at the first missing sequence. Starting from the
  // requested number would treat a hole as delivered.
  let contiguous = 0;
  for (const row of sequences) {
    if (row.local_sequence !== contiguous + 1) break;
    contiguous = row.local_sequence;
  }

  if (contiguous > 0) {
    db.prepare(
      `UPDATE event_outbox SET acknowledged = 1
       WHERE attempt_id = ? AND local_sequence <= ?`,
    ).run(params.attemptId, contiguous);
  }

  // Never report a watermark below what is already acknowledged. A late or
  // duplicate ACK carrying a lower number describes the past; returning it as
  // the current watermark would make a caller re-send events it already retired.
  const alreadyAcked = highestContiguousAcked(db, params.attemptId);
  return { ackedThrough: Math.max(alreadyAcked, contiguous) };
}

/** Highest contiguous acknowledged sequence; 0 when nothing is acknowledged. */
export function highestContiguousAcked(db: Database, attemptId: string): number {
  const row = db
    .prepare(
      `SELECT MAX(local_sequence) AS max_seq FROM event_outbox
       WHERE attempt_id = ? AND acknowledged = 1`,
    )
    .get(attemptId) as { max_seq: number | null } | null;

  return row?.max_seq ?? 0;
}

/**
 * How much unacknowledged work is sitting in the outbox (§12.6).
 *
 * Counted from the durable rows rather than from a running counter, so the
 * number cannot drift from what a restart would find — a counter and the table
 * would disagree exactly when the process died, which is the case the spool
 * thresholds exist for. `bytes` is the stored payload length, the disk cost,
 * not the parsed size.
 */
export function spoolDepth(db: Database, attemptId?: string): { events: number; bytes: number } {
  const columns = `COUNT(*) AS events, COALESCE(SUM(LENGTH(payload)), 0) AS bytes`;
  const row = (
    attemptId === undefined
      ? db
          .prepare(`SELECT ${columns} FROM event_outbox WHERE acknowledged = 0`)
          .get()
      : db
          .prepare(`SELECT ${columns} FROM event_outbox WHERE acknowledged = 0 AND attempt_id = ?`)
          .get(attemptId)
  ) as { events: number; bytes: number } | null;

  return { events: row?.events ?? 0, bytes: row?.bytes ?? 0 };
}
