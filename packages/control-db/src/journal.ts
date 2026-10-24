import type { Database } from "bun:sqlite";

/**
 * The server-side event journal (§12.1, §12.2).
 *
 * Delivery from a runner is at-least-once: the runner resends whatever the
 * server has not acknowledged, and a lost ACK after a commit arrives as a
 * duplicate. The journal therefore answers every ingest with one of
 *
 *  - `stored`    — first observation, committed with its session sequence
 *  - `duplicate` — the identical event again; changes nothing, allocates nothing
 *  - `conflict`  — the same identity (event id, or attempt position) carrying
 *                  different content; refused and audited, never overwritten
 */

/** One runner event as it arrives on the wire (§12.1). */
export type JournalEvent = {
  eventId: string;
  runnerId: string;
  bootId: string;
  sessionId: string;
  runId: string;
  attemptId: string;
  localSequence: number;
  occurredAt: string;
  type: string;
  payload: unknown;
};

export type IngestResult = {
  status: "stored" | "duplicate" | "conflict";
  /** The session sequence assigned to a stored event; undefined otherwise. */
  sessionSequence?: number;
};

export function ingestEvent(
  db: Database,
  event: JournalEvent,
  options: { now?: number } = {},
): IngestResult {
  const now = options.now ?? Date.now();
  const payload = JSON.stringify(event.payload ?? null);

  // One transaction per event, and the session sequence is allocated inside it:
  // §18.3 forbids `MAX()+1` outside a lock, because two concurrent ingests
  // would draw the same number and the replay order would depend on which
  // commit landed second.
  const tx = db.transaction((): IngestResult => {
    const existing = db
      .prepare(
        `SELECT event_id, runner_id, session_id, run_id, attempt_id, local_sequence,
                type, payload, occurred_at
         FROM run_events WHERE event_id = ?`,
      )
      .get(event.eventId) as StoredRow | null;

    if (existing !== null) {
      if (sameObservation(existing, event, payload)) return { status: "duplicate" };
      auditConflict(db, event, "event_id_reused_with_different_content", now);
      return { status: "conflict" };
    }

    const sequenceRow = db
      .prepare(
        "SELECT COALESCE(MAX(session_sequence), 0) + 1 AS next FROM run_events WHERE session_id = ?",
      )
      .get(event.sessionId) as { next: number };

    try {
      db.prepare(
        `INSERT INTO run_events
           (event_id, runner_id, boot_id, session_id, run_id, attempt_id,
            local_sequence, session_sequence, type, payload, occurred_at, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        event.eventId,
        event.runnerId,
        event.bootId,
        event.sessionId,
        event.runId,
        event.attemptId,
        event.localSequence,
        sequenceRow.next,
        event.type,
        payload,
        event.occurredAt,
        now,
      );
    } catch (error) {
      if (!/UNIQUE constraint failed/i.test((error as Error).message)) throw error;
      // The only unique keys are the event id (checked above — so this is a
      // same-process race at worst) and the attempt position. Either way the
      // claim is contradictory with something already committed.
      auditConflict(db, event, "unique_constraint_refused", now);
      return { status: "conflict" };
    }

    return { status: "stored", sessionSequence: sequenceRow.next };
  });

  return tx();
}

/**
 * The highest contiguous local sequence the journal holds for an attempt,
 * counting from 1 (§12.2). This is the number an ACK may carry: anything higher
 * would tell the runner a gap was delivered when it was not.
 */
export function attemptWatermark(db: Database, attemptId: string): number {
  const rows = db
    .prepare(
      "SELECT local_sequence FROM run_events WHERE attempt_id = ? ORDER BY local_sequence ASC",
    )
    .all(attemptId) as Array<{ local_sequence: number }>;

  let contiguous = 0;
  for (const row of rows) {
    if (row.local_sequence !== contiguous + 1) break;
    contiguous = row.local_sequence;
  }
  return contiguous;
}

type StoredRow = {
  event_id: string;
  runner_id: string;
  session_id: string;
  run_id: string;
  attempt_id: string;
  local_sequence: number;
  type: string;
  payload: string;
  occurred_at: string;
};

function sameObservation(row: StoredRow, event: JournalEvent, payload: string): boolean {
  return (
    row.event_id === event.eventId &&
    row.runner_id === event.runnerId &&
    row.session_id === event.sessionId &&
    row.run_id === event.runId &&
    row.attempt_id === event.attemptId &&
    row.local_sequence === event.localSequence &&
    row.type === event.type &&
    row.payload === payload &&
    row.occurred_at === event.occurredAt
  );
}

function auditConflict(db: Database, event: JournalEvent, detail: string, now: number): void {
  // The payload is deliberately not copied into the audit row: it is the part
  // under dispute, it is already subject to §19.4's redaction rules, and the
  // identities alone identify the incident.
  db.prepare(
    "INSERT INTO event_ingest_conflicts (event_id, detail, detected_at) VALUES (?, ?, ?)",
  ).run(event.eventId, `${detail} attempt=${event.attemptId} sequence=${event.localSequence}`, now);
}
