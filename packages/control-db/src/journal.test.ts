import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "./db.ts";
import {
  appendServerEvent,
  attemptWatermark,
  ingestEvent,
  type JournalEvent,
  SERVER_EVENT_SEQUENCE_BASE,
} from "./journal.ts";

/**
 * The server-side journal (§12.1, §12.2).
 *
 * Delivery is at-least-once, so the journal's whole correctness rests on two
 * properties tested here:
 *
 *  - a redelivered event is recognized as a duplicate and changes nothing —
 *    most importantly, it must not burn a `session_sequence`
 *  - the same identity carrying different content is a conflict, and conflicts
 *    are audited rather than silently dropped or overwritten
 */

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function event(overrides: Partial<JournalEvent> = {}): JournalEvent {
  return {
    eventId: "evt-1",
    runnerId: "runner-a",
    bootId: "boot-1",
    sessionId: "session-1",
    runId: "run-1",
    attemptId: "attempt-1",
    localSequence: 1,
    occurredAt: "2026-10-24T00:00:00.000Z",
    type: "run.started",
    payload: { commandId: "cmd-1" },
    ...overrides,
  };
}

describe("ingesting an event", () => {
  test("stores the event and allocates the first session sequence", () => {
    const db = setup();

    const first = ingestEvent(db, event());
    const second = ingestEvent(
      db,
      event({ eventId: "evt-2", localSequence: 2, type: "run.finished" }),
    );

    expect(first.status).toBe("stored");
    expect(second.status).toBe("stored");

    const rows = db
      .prepare("SELECT event_id, session_sequence FROM run_events ORDER BY session_sequence")
      .all() as Array<{ event_id: string; session_sequence: number }>;
    expect(rows).toEqual([
      { event_id: "evt-1", session_sequence: 1 },
      { event_id: "evt-2", session_sequence: 2 },
    ]);
  });

  test("session sequences are per session, not global", () => {
    const db = setup();

    ingestEvent(db, event({ sessionId: "session-1", localSequence: 1 }));
    ingestEvent(
      db,
      event({ sessionId: "session-2", eventId: "evt-b", attemptId: "attempt-2", localSequence: 1 }),
    );

    const rows = db
      .prepare("SELECT session_id, session_sequence FROM run_events ORDER BY session_id")
      .all() as Array<{ session_id: string; session_sequence: number }>;
    // §12.1: the web replays per session; a global counter would make every
    // session's replay offset depend on unrelated traffic.
    expect(rows).toEqual([
      { session_id: "session-1", session_sequence: 1 },
      { session_id: "session-2", session_sequence: 1 },
    ]);
  });

  test("a redelivered identical event is a duplicate that changes nothing", () => {
    const db = setup();

    ingestEvent(db, event());
    const again = ingestEvent(db, event());

    // At-least-once delivery makes this the normal case after a lost ACK
    // (§12.2). The journal must answer "already known", and the session
    // sequence must not advance: a duplicate that allocated one would leave a
    // hole in the session's replay order.
    expect(again.status).toBe("duplicate");
    expect(db.prepare("SELECT COUNT(*) AS n FROM run_events").get()).toEqual({ n: 1 });

    const next = ingestEvent(db, event({ eventId: "evt-2", localSequence: 2 }));
    expect(next.status).toBe("stored");
    const row = db
      .prepare("SELECT session_sequence FROM run_events WHERE event_id = ?")
      .get("evt-2") as { session_sequence: number };
    expect(row.session_sequence).toBe(2);
  });

  test("the same event id with different content is an audited conflict", () => {
    const db = setup();

    ingestEvent(db, event());
    const conflict = ingestEvent(db, event({ payload: { commandId: "tampered" } }));

    // §12.1: "conflicting duplicate phải được audit". Overwriting would let a
    // broken runner rewrite history; ignoring would hide it. The audit row is
    // what makes the incident investigable.
    expect(conflict.status).toBe("conflict");
    expect(db.prepare("SELECT COUNT(*) AS n FROM event_ingest_conflicts").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM run_events").get()).toEqual({ n: 1 });
  });

  test("a different event id reusing an (attempt, sequence) pair is an audited conflict", () => {
    const db = setup();

    ingestEvent(db, event());
    const conflict = ingestEvent(db, event({ eventId: "evt-impostor" }));

    // The (attemptId, localSequence) pair is the transcript's position. Two
    // events claiming one position cannot both be true.
    expect(conflict.status).toBe("conflict");
    expect(db.prepare("SELECT COUNT(*) AS n FROM event_ingest_conflicts").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM run_events").get()).toEqual({ n: 1 });
  });
});

describe("the acknowledgement watermark", () => {
  test("reports the highest contiguous sequence, never across a gap", () => {
    const db = setup();

    // §12.2: an ACK may not cross a gap. Sequences 1 and 2 stored, 4 arrives
    // before 3 — the watermark stays at 2 until 3 lands.
    ingestEvent(db, event({ localSequence: 1 }));
    ingestEvent(db, event({ eventId: "evt-2", localSequence: 2 }));
    ingestEvent(db, event({ eventId: "evt-4", localSequence: 4 }));

    expect(attemptWatermark(db, "attempt-1")).toBe(2);

    ingestEvent(db, event({ eventId: "evt-3", localSequence: 3 }));
    expect(attemptWatermark(db, "attempt-1")).toBe(4);
  });

  test("an attempt with nothing stored has watermark zero", () => {
    const db = setup();
    expect(attemptWatermark(db, "attempt-nobody")).toBe(0);
  });
});

describe("appending an event the server originates", () => {
  test("stores it above the runner's range without inflating the watermark", () => {
    const db = setup();
    ingestEvent(db, event({ localSequence: 1 }));
    ingestEvent(db, event({ eventId: "evt-2", localSequence: 2 }));

    const result = appendServerEvent(db, {
      runnerId: "runner-a",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      type: "approval.expired",
      payload: { approvalId: "apr-1", reason: "abandoned" },
      occurredAt: "2026-10-24T00:01:00.000Z",
    });

    expect(result.status).toBe("stored");
    expect(result.sessionSequence).toBe(3);
    // §12.2: an ACK may only vouch for what the runner itself sent. The server
    // row sits far above the reserved base, so the contiguous count is still 2.
    expect(attemptWatermark(db, "attempt-1")).toBe(2);

    const rows = db
      .prepare("SELECT type, payload, occurred_at FROM run_events WHERE event_id LIKE 'evt_srv_%'")
      .all() as Array<{ type: string; payload: string; occurred_at: string }>;
    expect(rows).toEqual([
      {
        type: "approval.expired",
        payload: JSON.stringify({ approvalId: "apr-1", reason: "abandoned" }),
        occurred_at: "2026-10-24T00:01:00.000Z",
      },
    ]);
  });

  test("gives successive server events distinct, increasing positions", () => {
    const db = setup();
    const input = {
      runnerId: "runner-a",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      type: "approval.expired" as const,
      payload: { approvalId: "apr-1", reason: "abandoned" as const },
    };

    expect(appendServerEvent(db, input).status).toBe("stored");
    expect(
      appendServerEvent(db, { ...input, payload: { approvalId: "apr-2", reason: "abandoned" } })
        .status,
    ).toBe("stored");

    const sequences = db
      .prepare("SELECT local_sequence, session_sequence FROM run_events ORDER BY session_sequence")
      .all() as Array<{ local_sequence: number; session_sequence: number }>;
    expect(sequences).toEqual([
      { local_sequence: SERVER_EVENT_SEQUENCE_BASE, session_sequence: 1 },
      { local_sequence: SERVER_EVENT_SEQUENCE_BASE + 1, session_sequence: 2 },
    ]);
  });
});
