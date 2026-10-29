import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "./db.ts";
import { registerWorkspace, upsertRunnerWorkspaces, workspacesForOwner } from "./workspaces.ts";

/**
 * What each runner serves (§15.1). The runner is the registration authority —
 * its hello/reconcile declaration is stored verbatim, and the sync is a
 * declarative replace: a boot that stops declaring a workspace must lose its
 * row, or placement would route work to a directory the runner no longer has.
 */

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

let seq = 0;
function seedRunner(db: Database, runnerId: string, ownerId = "owner-1"): void {
  db.prepare("INSERT INTO runners (id, owner_id, created_at) VALUES (?, ?, ?)").run(
    runnerId,
    ownerId,
    ++seq,
  );
}

let db: Database;

beforeEach(() => {
  db = setup();
  seq = 0;
});

describe("upsertRunnerWorkspaces", () => {
  test("inserts the declared set for one runner", () => {
    seedRunner(db, "runner-a");

    upsertRunnerWorkspaces(db, "runner-a", [
      { workspaceId: "default", path: "/srv/proj" },
      { workspaceId: "w-2", path: "/srv/other" },
    ]);

    const rows = db
      .prepare(
        "SELECT workspace_id, path FROM workspaces WHERE runner_id = 'runner-a' ORDER BY workspace_id",
      )
      .all() as Array<{ workspace_id: string; path: string }>;
    expect(rows).toEqual([
      { workspace_id: "default", path: "/srv/proj" },
      { workspace_id: "w-2", path: "/srv/other" },
    ]);
  });

  test("a second declaration replaces the first — no stale rows survive", () => {
    seedRunner(db, "runner-a");
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "w-2", path: "/srv/other" }]);

    const rows = db
      .prepare("SELECT workspace_id FROM workspaces WHERE runner_id = 'runner-a'")
      .all() as Array<{ workspace_id: string }>;
    expect(rows).toEqual([{ workspace_id: "w-2" }]);
  });

  test("a runner redeclaring a custom workspace's id takes the row over instead of throwing", () => {
    seedRunner(db, "runner-a");
    // The control plane minted this id for a folder the owner browsed to; the
    // runner learned it from a run and now declares it back.
    registerWorkspace(db, "runner-a", "ws-custom", "/srv/browsed");
    upsertRunnerWorkspaces(db, "runner-a", [
      { workspaceId: "ws-custom", path: "/srv/browsed", currentBranch: "main" },
    ]);

    const rows = db
      .prepare(
        "SELECT workspace_id, path, is_custom, current_branch FROM workspaces WHERE runner_id = 'runner-a'",
      )
      .all() as Array<{
      workspace_id: string;
      path: string;
      is_custom: number;
      current_branch: string | null;
    }>;
    expect(rows).toEqual([
      {
        workspace_id: "ws-custom",
        path: "/srv/browsed",
        is_custom: 0,
        current_branch: "main",
      },
    ]);
  });

  test("an empty declaration removes every row for the runner", () => {
    seedRunner(db, "runner-a");
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);

    upsertRunnerWorkspaces(db, "runner-a", []);

    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM workspaces WHERE runner_id = 'runner-a'")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  test("one runner's replace never touches another runner's rows", () => {
    seedRunner(db, "runner-a");
    seedRunner(db, "runner-b");
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    upsertRunnerWorkspaces(db, "runner-b", [{ workspaceId: "default", path: "/srv/other" }]);

    upsertRunnerWorkspaces(db, "runner-a", []);

    expect(
      (
        db.query("SELECT COUNT(*) AS n FROM workspaces WHERE runner_id = 'runner-b'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });
});

describe("workspacesForOwner", () => {
  test("returns the owner's workspaces with their runner and path", () => {
    seedRunner(db, "runner-a");
    seedRunner(db, "runner-b");
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    upsertRunnerWorkspaces(db, "runner-b", [{ workspaceId: "w-2", path: "/srv/other" }]);

    const workspaces = workspacesForOwner(db, "owner-1");
    expect(workspaces).toEqual([
      {
        workspaceId: "default",
        runnerId: "runner-a",
        path: "/srv/proj",
        branches: [],
        currentBranch: null,
        createdAt: expect.any(Number),
      },
      {
        workspaceId: "w-2",
        runnerId: "runner-b",
        path: "/srv/other",
        branches: [],
        currentBranch: null,
        createdAt: expect.any(Number),
      },
    ]);
  });

  test("revoked runners' workspaces never appear", () => {
    seedRunner(db, "runner-a");
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    db.prepare("UPDATE runners SET revoked_at = ? WHERE id = 'runner-a'").run(++seq);

    expect(workspacesForOwner(db, "owner-1")).toEqual([]);
  });

  test("another owner's workspaces never appear", () => {
    seedRunner(db, "runner-a", "owner-2");
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);

    expect(workspacesForOwner(db, "owner-1")).toEqual([]);
  });
});

describe("declared branches (M4)", () => {
  test("a declaration's branches round-trip to the owner's list", () => {
    seedRunner(db, "runner-a");
    upsertRunnerWorkspaces(db, "runner-a", [
      { workspaceId: "default", path: "/srv/proj", branches: ["main", "dev"] },
    ]);

    expect(workspacesForOwner(db, "owner-1")).toEqual([
      {
        workspaceId: "default",
        runnerId: "runner-a",
        path: "/srv/proj",
        branches: ["main", "dev"],
        currentBranch: null,
        createdAt: expect.any(Number),
      },
    ]);
  });

  test("a declaration without branches reads as an empty list", () => {
    seedRunner(db, "runner-a");
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);

    expect(workspacesForOwner(db, "owner-1")[0]!.branches).toEqual([]);
  });

  test("a re-declaration replaces branches wholesale, never accumulates", () => {
    seedRunner(db, "runner-a");
    upsertRunnerWorkspaces(db, "runner-a", [
      { workspaceId: "default", path: "/srv/proj", branches: ["main", "dev", "wip"] },
    ]);
    upsertRunnerWorkspaces(db, "runner-a", [
      { workspaceId: "default", path: "/srv/proj", branches: ["main"] },
    ]);

    expect(workspacesForOwner(db, "owner-1")[0]!.branches).toEqual(["main"]);
  });

  test("a declared current branch round-trips; a re-declaration without one clears it", () => {
    seedRunner(db, "runner-a");
    upsertRunnerWorkspaces(db, "runner-a", [
      { workspaceId: "default", path: "/srv/proj", branches: ["main"], currentBranch: "main" },
    ]);
    expect(workspacesForOwner(db, "owner-1")[0]!.currentBranch).toBe("main");

    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    expect(workspacesForOwner(db, "owner-1")[0]!.currentBranch).toBeNull();
  });

  test("garbage stored in the column reads as an empty list, never throws", () => {
    seedRunner(db, "runner-a");
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    db.prepare("UPDATE workspaces SET branches = 'not json' WHERE runner_id = 'runner-a'").run();

    expect(workspacesForOwner(db, "owner-1")[0]!.branches).toEqual([]);
  });
});
