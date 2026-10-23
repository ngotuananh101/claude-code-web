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
}
