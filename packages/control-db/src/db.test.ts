import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "./db.ts";

function tableNames(db: Database): string[] {
  return (
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

describe("migrate", () => {
  test("creates the better-auth tables", () => {
    const db = new Database(":memory:");
    migrate(db);
    const names = tableNames(db);

    // The exact set better-auth's own generator emits for SQLite with the
    // username plugin: user, session, account, verification.
    for (const table of ["user", "session", "account", "verification"]) {
      expect(names).toContain(table);
    }
  });

  test("better-auth user table carries the username column", () => {
    const db = new Database(":memory:");
    migrate(db);

    const columns = (
      db.query("PRAGMA table_info(user)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).toContain("username");
  });

  test("is idempotent", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });
});
