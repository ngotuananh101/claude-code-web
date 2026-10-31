import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "./db.ts";

function tableNames(db: Database): string[] {
  return (
    db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  ).map((row) => row.name);
}

describe("migrate", () => {
  test("creates the owner and runner tables", () => {
    const db = new Database(":memory:");
    migrate(db);
    const names = tableNames(db);

    // The owner table (ADR-0001) plus the connector model (ADR-015). The
    // better-auth tables are dropped, not created.
    for (const table of ["users", "runners", "runner_credentials"]) {
      expect(names).toContain(table);
    }
    for (const gone of ["user", "session", "account", "verification", "auth_sessions"]) {
      expect(names).not.toContain(gone);
    }
  });

  test("users carries the token_version column", () => {
    const db = new Database(":memory:");
    migrate(db);

    const columns = (db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(columns).toContain("token_version");
  });

  test("is idempotent", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });
});

describe("scheduled_tasks migration (§5.3)", () => {
  test("scheduled_tasks and its indexes exist after two migrations", () => {
    const db = new Database(":memory:");
    migrate(db);
    migrate(db); // idempotent: the server calls migrate() on every boot

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_tasks'")
      .all();
    expect(tables).toHaveLength(1);

    const indexes = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('scheduled_tasks_origin_cli', 'scheduled_tasks_due')",
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name).sort()).toEqual([
      "scheduled_tasks_due",
      "scheduled_tasks_origin_cli",
    ]);
  });
});

describe("run id indexes (§11.5)", () => {
  test("run_events and command_outbox answer run_id lookups from an index", () => {
    // The schedule tick asks "is this deterministic run id known?" for every
    // due row, every 15 seconds. Without these indexes each question is a full
    // scan of the journal and the outbox, which grow with every run.
    const db = new Database(":memory:");
    migrate(db);

    const indexes = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('run_events_run', 'command_outbox_run')",
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name).sort()).toEqual(["command_outbox_run", "run_events_run"]);

    const plan = (sql: string) =>
      (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
        .map((row) => row.detail)
        .join("\n");
    expect(plan("SELECT 1 FROM run_events WHERE run_id = 'r'")).toContain("run_events_run");
    expect(plan("SELECT 1 FROM command_outbox WHERE run_id = 'r'")).toContain("command_outbox_run");
  });
});

describe("scheduled-task indexes (§11.5)", () => {
  test("session lookups answer from an index", () => {
    // The Lịch tab lists one session's active rows on every open; without this
    // index each open is a full scan of a table that keeps a tombstone per
    // schedule ever created.
    const db = new Database(":memory:");
    migrate(db);

    const indexes = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'scheduled_tasks_session'",
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual(["scheduled_tasks_session"]);

    const plan = (
      db
        .query("EXPLAIN QUERY PLAN SELECT * FROM scheduled_tasks WHERE session_id = 's'")
        .all() as Array<{ detail: string }>
    )
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("scheduled_tasks_session");
  });
});

describe("workspaces.branches migration (M4)", () => {
  test("a database created before the column gains it on migrate", () => {
    const db = new Database(":memory:");
    // The previous schema: create the table without `branches`, as an
    // older release would have.
    db.exec(`
      CREATE TABLE workspaces (
        runner_id     TEXT NOT NULL,
        workspace_id  TEXT NOT NULL,
        path          TEXT NOT NULL,
        registered_at INTEGER NOT NULL,
        PRIMARY KEY (runner_id, workspace_id)
      );
    `);

    migrate(db);

    const columns = (
      db.query("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).toContain("branches");
  });

  test("a fresh database has the column from the start", () => {
    const db = new Database(":memory:");
    migrate(db);
    const columns = (
      db.query("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).toContain("branches");
  });
});
