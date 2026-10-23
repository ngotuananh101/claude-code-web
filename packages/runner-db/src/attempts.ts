import type { Database } from "bun:sqlite";

/**
 * Durable local execution state (§10.1, §9.7, §11.4).
 *
 * Two writes that §10.1 lists separately — acquire the workspace lock and
 * snapshot the attempt — happen in one transaction. The reason is the crash
 * window: if the lock were committed first and the row second, a daemon death
 * between the two leaves a lock with no owner record anywhere, and the
 * workspace is blocked until a human deletes the row.
 *
 * A terminal state (`finished`, `failed`, `interrupted`) is written at most
 * once per attempt. A second write is refused rather than merged, because the
 * first observation is evidence and later writes are guesses (§22.2).
 *
 * Recovery from an in-flight row happens on boot, not inside execution. The
 * inbox answers duplicates from stored state, so execution is never re-entered
 * for a previous attempt's id — a branch inside the executor would be code that
 * never runs.
 */

export type AttemptState = "starting" | "finished" | "failed" | "interrupted";

export type BeginInput = {
  attemptId: string;
  sessionId: string;
  runId: string;
  workspacePath: string;
  now?: number;
};

export type BeginResult =
  | { ok: true }
  | {
      ok: false;
      reason: "workspace_locked" | "attempt_exists";
      holderAttemptId?: string;
      state?: AttemptState;
    };

export type TerminalState = Exclude<AttemptState, "starting">;

/**
 * Begin an attempt: acquire its workspace lock and record it, atomically.
 *
 * Every refusal leaves the world exactly as it was. `attempt_exists` reports
 * the stored state so the caller can decide what a reused id means instead of
 * having this function guess.
 */
export function beginAttempt(db: Database, input: BeginInput): BeginResult {
  const now = input.now ?? Date.now();

  try {
    const tx = db.transaction(() => {
      const lock = db
        .prepare("SELECT attempt_id FROM workspace_locks WHERE workspace_path = ?")
        .get(input.workspacePath) as { attempt_id: string } | null;

      if (lock && lock.attempt_id !== input.attemptId) {
        throw new Locked(lock.attempt_id);
      }

      const existing = db
        .prepare("SELECT state FROM local_attempts WHERE attempt_id = ?")
        .get(input.attemptId) as { state: AttemptState } | null;

      if (existing) {
        throw new Exists(existing.state);
      }

      db.prepare(
        `INSERT INTO local_attempts (attempt_id, session_id, run_id, state, started_at, updated_at)
         VALUES (?, ?, ?, 'starting', ?, ?)`,
      ).run(input.attemptId, input.sessionId, input.runId, now, now);

      db.prepare(
        `INSERT INTO workspace_locks (workspace_path, attempt_id, acquired_at)
         VALUES (?, ?, ?)`,
      ).run(input.workspacePath, input.attemptId, now);
    });

    tx();
  } catch (error) {
    if (error instanceof Locked)
      return { ok: false, reason: "workspace_locked", holderAttemptId: error.holderAttemptId };
    if (error instanceof Exists) return { ok: false, reason: "attempt_exists", state: error.state };
    throw error;
  }

  return { ok: true };
}

class Locked extends Error {
  constructor(readonly holderAttemptId: string) {
    super("workspace locked by another attempt");
  }
}

class Exists extends Error {
  constructor(readonly state: AttemptState) {
    super("attempt already recorded");
  }
}

/**
 * Record the terminal outcome. Returns `recorded: false` when the attempt
 * already has a terminal state, is unknown, or — after a recovery — was marked
 * `interrupted`: that is the first observation and it stands.
 */
export function finishAttempt(
  db: Database,
  input: { attemptId: string; state: TerminalState; now?: number },
): { recorded: boolean } {
  const now = input.now ?? Date.now();

  const result = db
    .prepare(
      `UPDATE local_attempts SET state = ?, updated_at = ?
       WHERE attempt_id = ? AND state = 'starting'`,
    )
    .run(input.state, now, input.attemptId);

  return { recorded: result.changes === 1 };
}

/**
 * Drop the workspace lock, but only if this attempt still holds it.
 *
 * The attempt row itself is kept: it is the evidence reconciliation reports
 * (§14.3), and erasing it would make a completed run look like it never ran.
 */
export function releaseAttempt(db: Database, attemptId: string): void {
  db.prepare("DELETE FROM workspace_locks WHERE attempt_id = ?").run(attemptId);
}

/** The attempt that holds a workspace lock, if any. */
export function lockHolder(db: Database, workspacePath: string): string | undefined {
  const row = db
    .prepare("SELECT attempt_id FROM workspace_locks WHERE workspace_path = ?")
    .get(workspacePath) as { attempt_id: string } | null;
  return row?.attempt_id;
}

/** The stored state of an attempt, or undefined when there is none. */
export function attemptState(db: Database, attemptId: string): AttemptState | undefined {
  const row = db
    .prepare("SELECT state FROM local_attempts WHERE attempt_id = ?")
    .get(attemptId) as { state: string } | null;
  return row === null ? undefined : (row.state as AttemptState);
}

/**
 * Record the SDK session id an attempt obtained (§10.4).
 *
 * The id is created by the SDK, not by us: it is learned from the init frame
 * and only then is it worth storing. It lives on the attempt row, so the next
 * attempt of the same session can find it.
 */
export function recordSdkSessionId(db: Database, attemptId: string, sdkSessionId: string): void {
  db.prepare("UPDATE local_attempts SET sdk_session_id = ? WHERE attempt_id = ?").run(
    sdkSessionId,
    attemptId,
  );
}

/**
 * The SDK session id to resume for a session, if this runner has one.
 *
 * Looked up per session, and the most recent attempt wins — a session that
 * was resumed picks up where it left off rather than starting over (§10.4).
 */
export function sdkSessionIdForSession(db: Database, sessionId: string): string | undefined {
  const row = db
    .prepare(
      `SELECT sdk_session_id FROM local_attempts
       WHERE session_id = ? AND sdk_session_id IS NOT NULL
       ORDER BY started_at DESC, attempt_id DESC
       LIMIT 1`,
    )
    .get(sessionId) as { sdk_session_id: string | null } | null;
  return row?.sdk_session_id ?? undefined;
}

/**
 * On-boot recovery (§9.7).
 *
 * The daemon cannot know whether an in-flight attempt's process was alive when
 * it died — the SDK subprocess dies with the daemon and leaves no evidence
 * either way. So the row is marked `interrupted` and the lock released, and
 * nothing is re-run. The server learns the same on the next reconciliation.
 */
export function recoverStaleAttempts(db: Database, options: { now?: number } = {}): string[] {
  const now = options.now ?? Date.now();

  const rows = db
    .prepare("SELECT attempt_id FROM local_attempts WHERE state = 'starting'")
    .all() as Array<{ attempt_id: string }>;

  const recovered: string[] = [];
  for (const row of rows) {
    if (finishAttempt(db, { attemptId: row.attempt_id, state: "interrupted", now }).recorded) {
      // The attempt is over, so its workspace lock has no live owner. Leaving it
      // would block the workspace forever: the lock has no TTL and nothing else
      // knows the process is gone.
      releaseAttempt(db, row.attempt_id);
      recovered.push(row.attempt_id);
    }
  }

  // Locks whose attempt row is gone entirely — the pre-fix crash shape. No row
  // means no owner, which means no evidence and no future release.
  db.prepare(
    `DELETE FROM workspace_locks
     WHERE attempt_id NOT IN (SELECT attempt_id FROM local_attempts)`,
  ).run();

  // Locks held by an attempt that is already terminal: a crash between the
  // terminal write and the release. The run is over by the database's own
  // account, so nothing can ever release this lock — and only `starting` rows
  // were handled above, which is why it survived every boot.
  db.prepare(
    `DELETE FROM workspace_locks
     WHERE attempt_id IN (SELECT attempt_id FROM local_attempts WHERE state <> 'starting')`,
  ).run();

  return recovered;
}
