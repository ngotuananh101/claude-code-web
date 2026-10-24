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

  // Owner identity moved to better-auth (ADR-0002): the hand-rolled `users` /
  // `auth_sessions` tables are retired. DROP IF EXISTS keeps existing databases
  // from carrying dead tables; fresh ones never create them.
  db.exec(`
    DROP TABLE IF EXISTS auth_sessions;
    DROP TABLE IF EXISTS users;
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
  //
  // The envelope fields live in their own columns rather than inside `payload`:
  // §9.1 puts them at the top level of the frame, and the dispatcher has to
  // rebuild that frame from this row alone after a restart.
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
      session_id       TEXT,
      run_id           TEXT,
      attempt_id       TEXT,
      workspace_id     TEXT,
      delivery_state   TEXT NOT NULL,
      attempt_count    INTEGER NOT NULL DEFAULT 0,
      rejection_reason TEXT,
      created_at       INTEGER NOT NULL,
      last_sent_at     INTEGER,
      accepted_at      INTEGER,
      rejected_at      INTEGER
    );
  `);

  // Columns added after the table first shipped. `CREATE TABLE IF NOT EXISTS`
  // is a no-op on an existing database, so a new column needs its own step.
  addColumnIfMissing(db, "command_outbox", "session_id", "TEXT");
  addColumnIfMissing(db, "command_outbox", "run_id", "TEXT");
  addColumnIfMissing(db, "command_outbox", "attempt_id", "TEXT");
  addColumnIfMissing(db, "command_outbox", "workspace_id", "TEXT");

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

  // better-auth's tables (§6, ADR-0002). The library owns web authentication;
  // this DDL mirrors what its generator emits for SQLite with the username
  // plugin. Every column is dynamically typed in SQLite, so the declarations
  // are documentation plus NOT NULL/UNIQUE enforcement — the library writes
  // whatever shape it reads back.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL,
      image         TEXT,
      createdAt     TEXT NOT NULL,
      updatedAt     TEXT NOT NULL,
      username      TEXT UNIQUE
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id        TEXT PRIMARY KEY,
      expiresAt TEXT NOT NULL,
      token     TEXT NOT NULL UNIQUE,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      ipAddress TEXT,
      userAgent TEXT,
      userId    TEXT NOT NULL REFERENCES user (id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS account (
      id                    TEXT PRIMARY KEY,
      accountId             TEXT NOT NULL,
      providerId            TEXT NOT NULL,
      userId                TEXT NOT NULL REFERENCES user (id),
      accessToken           TEXT,
      refreshToken          TEXT,
      idToken               TEXT,
      accessTokenExpiresAt  INTEGER,
      refreshTokenExpiresAt INTEGER,
      scope                 TEXT,
      password              TEXT,
      createdAt             TEXT NOT NULL,
      updatedAt             TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS verification (
      id         TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value      TEXT NOT NULL,
      expiresAt  TEXT NOT NULL,
      createdAt  TEXT NOT NULL,
      updatedAt  TEXT NOT NULL
    );
  `);

  // The durable event journal (§12.1, §12.2). Events arrive at-least-once, so
  // both identities are unique: the event id (dedup after a lost ACK) and the
  // (attempt, local sequence) position (the transcript's order). A conflicting
  // duplicate is refused and audited, never overwritten.
  //
  // `session_sequence` is allocated at ingest, inside the inserting
  // transaction: the browser replays per session (§12.5), and the offset it
  // resumes from must not depend on other sessions' traffic.
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_events (
      event_id         TEXT PRIMARY KEY,
      runner_id        TEXT NOT NULL,
      boot_id          TEXT NOT NULL,
      session_id       TEXT NOT NULL,
      run_id           TEXT NOT NULL,
      attempt_id       TEXT NOT NULL,
      local_sequence   INTEGER NOT NULL,
      session_sequence INTEGER NOT NULL,
      type             TEXT NOT NULL,
      payload          TEXT NOT NULL,
      occurred_at      TEXT NOT NULL,
      ingested_at      INTEGER NOT NULL,
      UNIQUE (attempt_id, local_sequence)
    );
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS run_events_session_order
      ON run_events (session_id, session_sequence);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS run_events_attempt
      ON run_events (attempt_id, local_sequence);
  `);

  // §12.1: "conflicting duplicate phải được audit". The journal keeps the first
  // observation; this table is the record that something else claimed the same
  // identity, which is either a runner bug or an attack worth investigating.
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_ingest_conflicts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id    TEXT NOT NULL,
      detail      TEXT NOT NULL,
      detected_at INTEGER NOT NULL
    );
  `);
}

/**
 * Add a column to an existing table, once.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, and `PRAGMA table_info` is the only
 * portable way to ask. Without this, a database created before the column
 * existed would keep working right up until the first query that names it.
 */
function addColumnIfMissing(db: Database, table: string, column: string, type: string): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
