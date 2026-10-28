import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrateRunnerDb } from "./db.ts";
import { addCustomWorkspace, listCustomWorkspaces } from "./workspaces.ts";

/**
 * Custom workspaces the user chose at runtime by browsing the runner host
 * filesystem. These persist across daemon boots so a hand-picked folder (one
 * that is not under `~/.claude/projects` and not the default workspace) stays
 * available after a restart.
 */

function freshDb(): Database {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  return db;
}

describe("addCustomWorkspace", () => {
  test("inserts a row that reads back via listCustomWorkspaces", () => {
    const db = freshDb();

    addCustomWorkspace(db, { workspaceId: "ws-1", path: "/mnt/data/proj" }, 1_000);

    expect(listCustomWorkspaces(db)).toEqual([
      { workspaceId: "ws-1", path: "/mnt/data/proj", addedAt: 1_000 },
    ]);
  });

  test("records distinct workspaces separately", () => {
    const db = freshDb();

    addCustomWorkspace(db, { workspaceId: "ws-1", path: "/a" }, 1_000);
    addCustomWorkspace(db, { workspaceId: "ws-2", path: "/b" }, 2_000);

    expect(
      listCustomWorkspaces(db)
        .map((w) => w.workspaceId)
        .sort(),
    ).toEqual(["ws-1", "ws-2"]);
  });

  test("defaults addedAt to the current time when omitted", () => {
    const db = freshDb();
    const before = Date.now();

    addCustomWorkspace(db, { workspaceId: "ws-1", path: "/a" });

    const after = Date.now();
    const rows = listCustomWorkspaces(db);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row!.addedAt).toBeGreaterThanOrEqual(before);
    expect(row!.addedAt).toBeLessThanOrEqual(after);
  });

  test("deduplicates by path: re-adding the same path is a no-op", () => {
    const db = freshDb();

    addCustomWorkspace(db, { workspaceId: "ws-1", path: "/myproject" }, 1_000);
    // A different id but the same path must not duplicate the workspace.
    addCustomWorkspace(db, { workspaceId: "ws-2", path: "/myproject" }, 2_000);

    expect(listCustomWorkspaces(db)).toEqual([
      { workspaceId: "ws-1", path: "/myproject", addedAt: 1_000 },
    ]);
  });

  test("treats distinct paths case-sensitively as separate workspaces", () => {
    const db = freshDb();

    addCustomWorkspace(db, { workspaceId: "ws-1", path: "/A" }, 1_000);
    addCustomWorkspace(db, { workspaceId: "ws-2", path: "/a" }, 2_000);

    expect(listCustomWorkspaces(db)).toHaveLength(2);
  });
});

describe("listCustomWorkspaces", () => {
  test("answers an empty array when none have been added", () => {
    const db = freshDb();

    expect(listCustomWorkspaces(db)).toEqual([]);
  });

  test("lists every persisted workspace", () => {
    const db = freshDb();
    addCustomWorkspace(db, { workspaceId: "ws-1", path: "/a" }, 1_000);
    addCustomWorkspace(db, { workspaceId: "ws-2", path: "/b" }, 2_000);
    addCustomWorkspace(db, { workspaceId: "ws-3", path: "/c" }, 3_000);

    const listed = listCustomWorkspaces(db);
    expect(listed).toHaveLength(3);
    expect(listed.map((w) => w.path).sort()).toEqual(["/a", "/b", "/c"]);
  });
});
