import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "./db.ts";
import { ingestEvent, type JournalEvent } from "./journal.ts";
import {
  listSessions,
  readSessionEvents,
  sessionEarliest,
  sessionOwner,
  sessionWatermark,
} from "./replay.ts";

/**
 * The browser's read model over the journal (§12.5).
 *
 * Replay is the reason `session_sequence` exists: the browser resumes from an
 * offset, and everything here must answer in that one coordinate system —
 * ordered, bounded, and never mixing sessions. Ownership is the other half of
 * §12.5: a subscription is only honored for the session's owner, so the read
 * model has to be able to say whose session this is.
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

function seedSession(db: Database, sessionId: string, count: number): void {
  for (let i = 1; i <= count; i++) {
    ingestEvent(
      db,
      event({
        sessionId,
        attemptId: `attempt-${sessionId}`,
        eventId: `evt-${sessionId}-${i}`,
        localSequence: i,
        type: i === count ? "run.finished" : "message.delta",
        payload: { n: i },
      }),
    );
  }
}

describe("reading a session for replay", () => {
  test("returns the session's events in session order with parsed payloads", () => {
    const db = setup();
    seedSession(db, "session-1", 3);
    seedSession(db, "session-2", 2);

    const events = readSessionEvents(db, "session-1", { after: 0 });

    // §12.5: the browser resumes in session_sequence and dedups by it, so that
    // field leads. runnerId/bootId are control-plane metadata, not replay
    // content — the projection leaves them out.
    expect(events.map((e) => [e.sessionSequence, e.eventId, e.type])).toEqual([
      [1, "evt-session-1-1", "message.delta"],
      [2, "evt-session-1-2", "message.delta"],
      [3, "evt-session-1-3", "run.finished"],
    ]);
    expect(events[0]!.payload).toEqual({ n: 1 });
    expect("runnerId" in events[0]!).toBe(false);
    expect("bootId" in events[0]!).toBe(false);
  });

  test("after excludes everything at or below the offset", () => {
    const db = setup();
    seedSession(db, "session-1", 4);

    const events = readSessionEvents(db, "session-1", { after: 2 });
    expect(events.map((e) => e.sessionSequence)).toEqual([3, 4]);
  });

  test("limit bounds one replay batch, in order", () => {
    const db = setup();
    seedSession(db, "session-1", 5);

    const batch = readSessionEvents(db, "session-1", { after: 0, limit: 2 });
    expect(batch.map((e) => e.sessionSequence)).toEqual([1, 2]);
  });

  test("the watermark is the highest committed sequence, 0 when empty", () => {
    const db = setup();
    expect(sessionWatermark(db, "session-1")).toBe(0);

    seedSession(db, "session-1", 3);
    expect(sessionWatermark(db, "session-1")).toBe(3);
    expect(sessionWatermark(db, "session-unknown")).toBe(0);
  });

  test("the earliest sequence exposes a retention gap", () => {
    const db = setup();
    seedSession(db, "session-1", 5);

    // Retention does not exist yet; simulate its future effect so the §12.5
    // path (resync_required) is provable before it can occur in production.
    db.prepare("DELETE FROM run_events WHERE session_id = ? AND session_sequence <= 3").run(
      "session-1",
    );

    expect(sessionEarliest(db, "session-1")).toBe(4);
    expect(sessionWatermark(db, "session-1")).toBe(5);
    // after 0 + earliest 4: the client's offset points into deleted history.
    expect(sessionEarliest(db, "session-1")).toBeGreaterThan(1);
  });
});

describe("session ownership", () => {
  function registerRunner(db: Database, runnerId: string, ownerId: string): void {
    db.prepare("INSERT INTO runners (id, owner_id, created_at) VALUES (?, ?, ?)").run(
      runnerId,
      ownerId,
      1,
    );
  }

  test("derives the owner from the journal once events exist", () => {
    const db = setup();
    registerRunner(db, "runner-a", "owner-1");
    seedSession(db, "session-1", 2);

    expect(sessionOwner(db, "session-1")).toBe("owner-1");
  });

  test("falls back to the command outbox before any event is journaled", () => {
    const db = setup();
    registerRunner(db, "runner-a", "owner-1");
    db.prepare(
      `INSERT INTO command_outbox
         (command_id, runner_id, kind, payload, fingerprint, issued_at,
          session_id, run_id, attempt_id, workspace_id, delivery_state, created_at)
       VALUES ('cmd-1', 'runner-a', 'run.start', '{}', 'fp', '2026-10-24T00:00:00Z',
               'session-1', 'run-1', 'attempt-1', 'workspace-1', 'pending', 1)`,
    ).run();

    // The subscribe-before-first-run case: ownership must hold from dispatch,
    // not only once events arrive.
    expect(sessionOwner(db, "session-1")).toBe("owner-1");
  });

  test("falls back to active_runs for a run in flight", () => {
    const db = setup();
    registerRunner(db, "runner-a", "owner-2");
    db.prepare(
      `INSERT INTO active_runs (run_id, session_id, runner_id, attempt_id, dispatched_at)
       VALUES ('run-1', 'session-1', 'runner-a', 'attempt-1', 1)`,
    ).run();

    expect(sessionOwner(db, "session-1")).toBe("owner-2");
  });

  test("an unknown session has no owner", () => {
    const db = setup();
    expect(sessionOwner(db, "session-nobody")).toBeUndefined();
  });
});

describe("listing an owner's sessions", () => {
  function registerRunner(db: Database, runnerId: string, ownerId: string): void {
    db.prepare("INSERT INTO runners (id, owner_id, created_at) VALUES (?, ?, ?)").run(
      runnerId,
      ownerId,
      1,
    );
  }

  test("summarizes each session with its watermark, tail, and liveness", () => {
    const db = setup();
    registerRunner(db, "runner-a", "owner-1");
    seedSession(db, "session-1", 4);
    seedSession(db, "session-2", 1);

    const sessions = listSessions(db, "owner-1");

    // The sidebar's whole job in one row: which session, how far it goes, what
    // happened last, and whether something is running right now.
    expect(sessions).toHaveLength(2);
    const first = sessions.find((s) => s.sessionId === "session-1");
    expect(first).toMatchObject({
      sessionId: "session-1",
      watermark: 4,
      eventCount: 4,
      lastEventType: "run.finished",
      live: false,
    });
    const second = sessions.find((s) => s.sessionId === "session-2");
    expect(second?.watermark).toBe(1);
  });

  test("a dispatched session appears before any event is journaled, marked live", () => {
    const db = setup();
    registerRunner(db, "runner-a", "owner-1");
    db.prepare(
      `INSERT INTO active_runs (run_id, session_id, runner_id, attempt_id, dispatched_at)
       VALUES ('run-1', 'session-fresh', 'runner-a', 'attempt-1', 1)`,
    ).run();

    const sessions = listSessions(db, "owner-1");

    // §16.1: the sidebar must not wait for the first event — a run in flight
    // is the moment the owner most wants to see the session listed.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "session-fresh",
      watermark: 0,
      eventCount: 0,
      lastEventType: null,
      live: true,
    });
  });

  test("another owner's sessions are invisible", () => {
    const db = setup();
    registerRunner(db, "runner-a", "owner-1");
    registerRunner(db, "runner-b", "owner-2");
    seedSession(db, "session-mine", 2);
    ingestEvent(
      db,
      event({
        sessionId: "session-theirs",
        eventId: "evt-theirs-1",
        runnerId: "runner-b",
        attemptId: "attempt-b",
        localSequence: 1,
      }),
    );

    const mine = listSessions(db, "owner-1");
    expect(mine.map((s) => s.sessionId)).toEqual(["session-mine"]);
  });

  test("most recently active first", () => {
    const db = setup();
    registerRunner(db, "runner-a", "owner-1");
    seedSession(db, "session-old", 1);
    seedSession(db, "session-new", 1);

    const sessions = listSessions(db, "owner-1");
    expect(sessions.map((s) => s.sessionId)).toEqual(["session-new", "session-old"]);
  });
});
