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
