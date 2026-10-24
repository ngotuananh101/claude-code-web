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
