import type { Database } from "bun:sqlite";

/**
 * Runner-local SQLite schema (§18.2).
 *
 * Lives on the Runner's own disk — never NFS, never a shared network database
 * file. Migrations must be idempotent because the daemon calls them on every
 * boot, including after a crash mid-migration.
 */
export function migrateRunnerDb(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  // The durable inbox: every accepted command, with a fingerprint that detects
  // the same ID being reused for a different payload (§9.3).
  db.exec(`
    CREATE TABLE IF NOT EXISTS command_inbox (
      command_id    TEXT PRIMARY KEY,
      runner_id     TEXT NOT NULL,
      kind          TEXT NOT NULL,
      fingerprint   TEXT NOT NULL,
      state         TEXT NOT NULL,
      payload       TEXT NOT NULL,
      accepted_at   INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_rejections (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      command_id TEXT NOT NULL,
      reason     TEXT NOT NULL,
      rejected_at INTEGER NOT NULL
    );
  `);

  // Durable, ordered event outbox with the ACK watermark (§12.2).
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_outbox (
      event_id       TEXT PRIMARY KEY,
      attempt_id     TEXT NOT NULL,
      local_sequence INTEGER NOT NULL,
      session_id     TEXT NOT NULL,
      run_id         TEXT NOT NULL,
      type           TEXT NOT NULL,
      payload        TEXT NOT NULL,
      occurred_at    TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      acknowledged   INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Uniqueness on (attempt, sequence) is what makes event replay idempotent
  // rather than duplicating transcript content.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS event_outbox_attempt_sequence
      ON event_outbox (attempt_id, local_sequence);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS local_attempts (
      attempt_id    TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      run_id        TEXT NOT NULL,
      sdk_session_id TEXT,
      state         TEXT NOT NULL,
      started_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_locks (
      workspace_path TEXT PRIMARY KEY,
      attempt_id     TEXT NOT NULL,
      acquired_at    INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_approvals (
      approval_id       TEXT PRIMARY KEY,
      attempt_id        TEXT NOT NULL,
      tool_call_id      TEXT NOT NULL,
      input_hash        TEXT NOT NULL,
      callback_generation TEXT NOT NULL,
      kind              TEXT NOT NULL,
      expires_at        INTEGER NOT NULL,
      state             TEXT NOT NULL,
      created_at        INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS registered_workspaces (
      id            TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      display_name  TEXT,
      trusted_at    INTEGER NOT NULL
    );
  `);

  // Run-start file snapshots (§15.4, §18.2): one snapshot_runs row per captured
  // baseline, one file_snapshots row per file in it. Content itself lives in
  // on-disk blobs keyed by hash; the DB only stores references.
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshot_runs (
      attempt_id     TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,      -- canonical realpath
      session_id     TEXT,
      collector      TEXT NOT NULL,      -- 'git' | 'walk'
      captured_at    INTEGER NOT NULL,
      partial        INTEGER NOT NULL DEFAULT 0,
      file_count     INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS file_snapshots (
      attempt_id TEXT NOT NULL,
      path       TEXT NOT NULL,          -- workspace-relative
      state      TEXT NOT NULL,          -- 'kept' | 'excluded'
      hash       TEXT,                  -- sha256 hex, null when excluded
      size       INTEGER,
      mode       INTEGER,
      reason     TEXT,                  -- excluded: credential | symlink | oversize | unbaselined | non_regular
      PRIMARY KEY (attempt_id, path)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS file_snapshots_hash ON file_snapshots (hash);
  `);
}
