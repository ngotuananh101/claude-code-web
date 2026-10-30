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

  // Owner identity is ours again (ADR-0001, reinstated 2026-10-25): the
  // better-auth tables are retired along with the enrollment they replaced.
  // DROP IF EXISTS keeps existing databases from carrying dead tables; fresh
  // ones never create them.
  db.exec(`
    DROP TABLE IF EXISTS enrollments;
    DROP TABLE IF EXISTS verification;
    DROP TABLE IF EXISTS account;
    DROP TABLE IF EXISTS session;
    DROP TABLE IF EXISTS user;
    DROP TABLE IF EXISTS auth_sessions;
  `);

  // The single owner account. `token_version` is the revocation lever: a
  // signed token names the version it was minted under, and every check
  // compares that against this row (ADR-0001).
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

  // Approvals projection (§13). The runner's `approval.requested` events are
  // flattened here so the decision route can validate and close an approval
  // without scanning the journal. `state` follows the projection's own
  // lifecycle: pending → decided (a user decision is recorded) → resolved
  // (the runner confirmed the outcome). The event payload only ever carries a
  // redacted summary; the full tool input never leaves the runner.
  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      approval_id   TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      run_id        TEXT NOT NULL,
      attempt_id    TEXT NOT NULL,
      runner_id     TEXT NOT NULL,
      kind          TEXT NOT NULL,
      tool_name     TEXT NOT NULL,
      input_hash    TEXT NOT NULL,
      input_summary TEXT NOT NULL,
      expires_at    INTEGER NOT NULL,
      state         TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );
  `);

  // One row per accepted decision, written in the same transaction as the
  // `approval.respond` outbox command — the atomicity §13.1 requires.
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_decisions (
      approval_id  TEXT NOT NULL REFERENCES approvals (approval_id),
      decision     TEXT NOT NULL,
      answers_json TEXT,
      decided_at   INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS approvals_session
      ON approvals (session_id);
  `);

  // What each runner currently serves (§15.1). The runner is the registration
  // authority: rows are a declarative replace per runner on every hello and
  // reconcile, so a boot that stops declaring a workspace loses its row —
  // placement can never pick a workspace the current boot does not vouch for.
  // `branches` (M4) is a JSON array of the workspace's local heads at the
  // last declaration; the JSON column keeps the declarative replace whole.
  // `current_branch` is the head HEAD pointed at then — display only, NULL
  // when unknown.
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      runner_id      TEXT NOT NULL REFERENCES runners (id),
      workspace_id   TEXT NOT NULL,
      path           TEXT NOT NULL,
      branches       TEXT NOT NULL DEFAULT '[]',
      current_branch TEXT,
      registered_at INTEGER NOT NULL,
      is_custom     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (runner_id, workspace_id)
    );
  `);
  addColumnIfMissing(db, "workspaces", "branches", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "workspaces", "is_custom", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "workspaces", "current_branch", "TEXT");

  // Where each session lives (§2.3, ADR-006): the (workspace, runner) pin an
  // accepted dispatch records, so every later run of the session rides it
  // instead of re-running placement. First pin wins — written INSERT OR
  // IGNORE, never updated. Like active_runs, dispatch plumbing whose ids the
  // route validated upstream; no foreign keys.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      owner_id     TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      runner_id    TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );
  `);
  addColumnIfMissing(db, "sessions", "title", "TEXT");
  addColumnIfMissing(db, "runners", "name", "TEXT");
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
