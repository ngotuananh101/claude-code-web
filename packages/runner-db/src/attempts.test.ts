import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  attemptState,
  beginAttempt,
  finishAttempt,
  lockHolder,
  recordSdkSessionId,
  recoverStaleAttempts,
  releaseAttempt,
  sdkSessionIdForSession,
} from "./attempts.ts";
import { migrateRunnerDb } from "./db.ts";

/**
 * Durable local execution state (§10.1, §9.7, §11.4).
 *
 * Two properties matter more than anything else here:
 *
 *  1. The workspace lock and the attempt row are created together. §10.1 puts
 *     the lock before the metadata snapshot; if those were two separate writes,
 *     a crash between them leaves a lock nobody owns and the workspace is
 *     blocked forever.
 *  2. A terminal state is written once. §14.2/§22.2 make terminal transitions
 *     idempotent, and a second write would turn a real outcome into a guess.
 */

function freshDb(): Database {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  return db;
}

const attempt = {
  attemptId: "attempt-1",
  sessionId: "session-1",
  runId: "run-1",
  workspacePath: "/home/runner/project",
  now: 1_000,
};

describe("beginning an attempt", () => {
  test("acquires the workspace lock and records the attempt together", () => {
    const db = freshDb();

    const result = beginAttempt(db, attempt);

    expect(result).toEqual({ ok: true });
    expect(attemptState(db, "attempt-1")).toBe("starting");
    expect(lockHolder(db, "/home/runner/project")).toBe("attempt-1");
  });

  test("refuses a second attempt on a locked workspace, leaving the holder intact", () => {
    const db = freshDb();
    beginAttempt(db, attempt);

    const second = beginAttempt(db, { ...attempt, attemptId: "attempt-2", runId: "run-2" });

    expect(second).toEqual({
      ok: false,
      reason: "workspace_locked",
      holderAttemptId: "attempt-1",
    });
    expect(attemptState(db, "attempt-2")).toBeUndefined();
    expect(lockHolder(db, "/home/runner/project")).toBe("attempt-1");
  });

  test("refuses a reused attempt id instead of overwriting real state", () => {
    const db = freshDb();
    beginAttempt(db, attempt);
    finishAttempt(db, { attemptId: "attempt-1", state: "finished", now: 2_000 });
    releaseAttempt(db, "attempt-1");

    const again = beginAttempt(db, { ...attempt, now: 3_000 });

    // Overwriting would erase a terminal outcome and make a second execution
    // look like the first one never happened.
    expect(again).toEqual({ ok: false, reason: "attempt_exists", state: "finished" });
    expect(lockHolder(db, "/home/runner/project")).toBeUndefined();
  });
});

describe("finishing an attempt", () => {
  test("records the terminal state and reports that it did", () => {
    const db = freshDb();
    beginAttempt(db, attempt);

    expect(finishAttempt(db, { attemptId: "attempt-1", state: "finished", now: 2_000 })).toEqual({
      recorded: true,
    });
    expect(attemptState(db, "attempt-1")).toBe("finished");
  });

  test("a second terminal write is refused, so the first outcome stands", () => {
    const db = freshDb();
    beginAttempt(db, attempt);
    finishAttempt(db, { attemptId: "attempt-1", state: "finished", now: 2_000 });

    const again = finishAttempt(db, { attemptId: "attempt-1", state: "failed", now: 3_000 });

    expect(again).toEqual({ recorded: false });
    expect(attemptState(db, "attempt-1")).toBe("finished");
  });

  test("an unknown attempt is not recorded, rather than invented", () => {
    const db = freshDb();

    expect(finishAttempt(db, { attemptId: "nope", state: "failed", now: 1_000 })).toEqual({
      recorded: false,
    });
    expect(attemptState(db, "nope")).toBeUndefined();
  });
});

describe("releasing an attempt", () => {
  test("frees the workspace lock and keeps the attempt record", () => {
    const db = freshDb();
    beginAttempt(db, attempt);

    releaseAttempt(db, "attempt-1");

    expect(lockHolder(db, "/home/runner/project")).toBeUndefined();
    // The record is the evidence reconciliation needs; only the lock is dropped.
    expect(attemptState(db, "attempt-1")).toBe("starting");
  });

  test("does not free a lock another attempt now holds", () => {
    const db = freshDb();
    beginAttempt(db, attempt);
    finishAttempt(db, { attemptId: "attempt-1", state: "finished", now: 2_000 });
    releaseAttempt(db, "attempt-1");
    beginAttempt(db, { ...attempt, attemptId: "attempt-2", runId: "run-2", now: 3_000 });

    releaseAttempt(db, "attempt-1");

    expect(lockHolder(db, "/home/runner/project")).toBe("attempt-2");
  });
});

describe("recovering after a crash", () => {
  test("an attempt left in flight is marked interrupted, never re-run", () => {
    const db = freshDb();
    beginAttempt(db, attempt);

    // This is what the daemon sees on the next boot: a row that was never
    // finished, and no process behind it. §9.7 says the honest answer is
    // `interrupted`, and that it must not be respawned.
    const recovered = recoverStaleAttempts(db, { now: 5_000 });

    expect(recovered).toEqual(["attempt-1"]);
    expect(attemptState(db, "attempt-1")).toBe("interrupted");
  });

  test("recovery frees the workspace lock it interrupted", () => {
    const db = freshDb();
    beginAttempt(db, attempt);

    recoverStaleAttempts(db, { now: 5_000 });

    // Without this, a crash would block the workspace forever — the lock has no
    // TTL and nothing else knows the owner is gone.
    expect(lockHolder(db, "/home/runner/project")).toBeUndefined();
  });

  test("a finished attempt is left alone", () => {
    const db = freshDb();
    beginAttempt(db, attempt);
    finishAttempt(db, { attemptId: "attempt-1", state: "finished", now: 2_000 });
    releaseAttempt(db, "attempt-1");

    expect(recoverStaleAttempts(db, { now: 5_000 })).toEqual([]);
    expect(attemptState(db, "attempt-1")).toBe("finished");
  });

  test("recovery is idempotent across repeated boots", () => {
    const db = freshDb();
    beginAttempt(db, attempt);

    expect(recoverStaleAttempts(db, { now: 5_000 })).toEqual(["attempt-1"]);
    // A normal restart must not keep reporting the same attempt as newly
    // interrupted, or every boot would append another failure.
    expect(recoverStaleAttempts(db, { now: 6_000 })).toEqual([]);
  });

  test("an orphaned lock with no attempt row is released", () => {
    const db = freshDb();
    // Written directly: this is the shape a crash at the wrong instant used to
    // leave behind before the two writes were made one transaction.
    db.prepare(
      "INSERT INTO workspace_locks (workspace_path, attempt_id, acquired_at) VALUES (?, ?, ?)",
    ).run("/home/runner/ghost", "ghost-attempt", 1_000);

    recoverStaleAttempts(db, { now: 5_000 });

    expect(lockHolder(db, "/home/runner/ghost")).toBeUndefined();
  });

  test("a terminal attempt that still holds its lock has the lock released", () => {
    const db = freshDb();
    beginAttempt(db, attempt);
    // A crash between the terminal write and the lock release: the attempt is
    // finished but the workspace is still locked, and recovery used to only look
    // at `starting` rows. The workspace then stayed blocked for every later run,
    // with a row that says the run is over.
    finishAttempt(db, { attemptId: "attempt-1", state: "finished", now: 2_000 });

    recoverStaleAttempts(db, { now: 5_000 });

    expect(attemptState(db, "attempt-1")).toBe("finished");
    expect(lockHolder(db, "/home/runner/project")).toBeUndefined();
  });

  test("a live starting attempt is not treated as terminal", () => {
    const db = freshDb();
    beginAttempt(db, attempt);

    // Recovery marks it interrupted, which is the only state it may write. It
    // must never invent `finished` or `failed` for work nobody observed.
    recoverStaleAttempts(db, { now: 5_000 });

    expect(attemptState(db, "attempt-1")).toBe("interrupted");
  });
});

describe("the SDK session id", () => {
  test("is recorded against the attempt", () => {
    const db = freshDb();
    beginAttempt(db, attempt);

    recordSdkSessionId(db, "attempt-1", "sdk-1");

    expect(sdkSessionIdForSession(db, "session-1")).toBe("sdk-1");
  });

  test("is looked up by session, so the next run can resume it", () => {
    const db = freshDb();
    beginAttempt(db, attempt);
    recordSdkSessionId(db, "attempt-1", "sdk-1");

    // §10.4: each follow-up run uses that specific id, never `continue: true`,
    // which would pick whichever conversation happened to be newest.
    expect(sdkSessionIdForSession(db, "session-1")).toBe("sdk-1");
    expect(sdkSessionIdForSession(db, "session-2")).toBeUndefined();
  });

  test("a later attempt for the same session wins", () => {
    const db = freshDb();
    beginAttempt(db, attempt);
    recordSdkSessionId(db, "attempt-1", "sdk-1");
    finishAttempt(db, { attemptId: "attempt-1", state: "finished", now: 2_000 });
    releaseAttempt(db, "attempt-1");
    beginAttempt(db, { ...attempt, attemptId: "attempt-2", runId: "run-2", now: 3_000 });
    recordSdkSessionId(db, "attempt-2", "sdk-2");

    expect(sdkSessionIdForSession(db, "session-1")).toBe("sdk-2");
  });

  test("an unknown session has no session id", () => {
    const db = freshDb();
    expect(sdkSessionIdForSession(db, "session-1")).toBeUndefined();
  });
});
