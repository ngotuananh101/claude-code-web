import type { Database } from "bun:sqlite";

/**
 * Control database migrations.
 *
 * Schema is deliberately minimal: it grows one table at a time as each phase
 * needs it. Every migration must be safe to run twice (idempotent DDL) because
 * the server calls `migrate()` on every boot.
 *
 * See ARCHITECTURE.md §18.1 for the full target schema.
 */
export function migrate(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS enrollments (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT NOT NULL,
      -- SHA-256 of the token. The token itself is never persisted, so a database
      -- read cannot be replayed as an enrollment (§6.1).
      token_hash  TEXT NOT NULL UNIQUE,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      consumed_at INTEGER
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS enrollments_token_hash
      ON enrollments (token_hash);
  `);

  // Owner identity (§18.1, ADR-0001). `token_version` is the revocation
  // primitive: every access token names the version it was minted under, so
  // incrementing this column invalidates all of them at once.
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      -- A maintained library's output, never hand-rolled (§19.1).
      password_hash TEXT NOT NULL,
      token_version INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL
    );
  `);

  // One row per login. Kept alongside the version so a single session can be
  // revoked without logging the user out everywhere.
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users (id),
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS auth_sessions_user_id
      ON auth_sessions (user_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runners (
      id         TEXT PRIMARY KEY,
      owner_id   TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
  `);

  // Credential history is kept rather than overwritten: a rotation must be able
  // to invalidate the previous secret (§6.3) while leaving an audit trail.
  db.exec(`
    CREATE TABLE IF NOT EXISTS runner_credentials (
      id          TEXT PRIMARY KEY,
      runner_id   TEXT NOT NULL REFERENCES runners (id),
      secret_hash TEXT NOT NULL UNIQUE,
      issued_at   INTEGER NOT NULL,
      revoked_at  INTEGER
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS runner_credentials_secret_hash
      ON runner_credentials (secret_hash);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS runner_credentials_runner_id
      ON runner_credentials (runner_id);
  `);

  // Central command outbox (§18.1, §9.3). A command is written here before it is
  // sent, so a crash between "decided" and "delivered" loses nothing.
  db.exec(`
    CREATE TABLE IF NOT EXISTS command_outbox (
      command_id       TEXT PRIMARY KEY,
      runner_id        TEXT NOT NULL,
      kind             TEXT NOT NULL,
      payload          TEXT NOT NULL,
      -- Immutable per command id: the same id with different content is a
      -- caller bug or an attack, never a retry (§9.3).
      fingerprint      TEXT NOT NULL,
      issued_at        TEXT NOT NULL,
      expires_at       TEXT,
      delivery_state   TEXT NOT NULL,
      attempt_count    INTEGER NOT NULL DEFAULT 0,
      attempt_id       TEXT,
      rejection_reason TEXT,
      created_at       INTEGER NOT NULL,
      last_sent_at     INTEGER,
      accepted_at      INTEGER,
      rejected_at      INTEGER
    );
  `);

  // The drain query is "undelivered commands for one runner", so index exactly
  // that rather than scanning the table per reconnect.
  db.exec(`
    CREATE INDEX IF NOT EXISTS command_outbox_runner_state
      ON command_outbox (runner_id, delivery_state, created_at);
  `);

  // Server-side view of which run is live. This is what enforces §2.3's "one
  // active run per session" and the per-runner capacity count, without asking a
  // Runner that may be unreachable.
  db.exec(`
    CREATE TABLE IF NOT EXISTS active_runs (
      run_id        TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      runner_id     TEXT NOT NULL,
      attempt_id    TEXT NOT NULL,
      dispatched_at INTEGER NOT NULL
    );
  `);

  // A session may hold at most one active run. Enforced in the schema as well as
  // in the scheduler, so a second code path cannot violate it by forgetting.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS active_runs_one_per_session
      ON active_runs (session_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS active_runs_runner
      ON active_runs (runner_id);
  `);
}
