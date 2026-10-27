import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrateRunnerDb } from "./db.ts";
import { latestSnapshot, pruneSnapshots, recordSnapshot } from "./snapshots.ts";

function setup() {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  return db;
}

const entry = (path: string, hash: string) => ({
  path,
  state: "kept" as const,
  hash,
  size: 4,
  mode: 0o644,
});

test("the newest baseline wins and its entries come back sorted", () => {
  const db = setup();
  recordSnapshot(db, {
    attemptId: "a-old",
    workspacePath: "/w",
    collector: "git",
    capturedAt: 1,
    partial: false,
    entries: [entry("b.ts", "h2"), entry("a.ts", "h1")],
  });
  recordSnapshot(db, {
    attemptId: "a-new",
    workspacePath: "/w",
    collector: "walk",
    capturedAt: 2,
    partial: true,
    entries: [entry("c.ts", "h3")],
  });
  const latest = latestSnapshot(db, "/w");
  expect(latest?.run.attemptId).toBe("a-new");
  expect(latest?.run.collector).toBe("walk");
  expect(latest?.run.partial).toBe(true);
  expect(latest?.entries.map((e) => e.path)).toEqual(["c.ts"]);
  expect(latestSnapshot(db, "/elsewhere")).toBeUndefined();
});

test("pruning keeps the newest N and reports only hashes nothing references", () => {
  const db = setup();
  for (let i = 0; i < 3; i++) {
    recordSnapshot(db, {
      attemptId: `a-${i}`,
      workspacePath: "/w",
      collector: "git",
      capturedAt: i,
      partial: false,
      entries: [entry(`f-${i}.ts`, `h-${i}`), entry("shared.ts", "shared")],
    });
  }
  const dropped = pruneSnapshots(db, "/w", 2);
  expect(dropped.sort()).toEqual(["h-0"]);
  expect(latestSnapshot(db, "/w")?.run.attemptId).toBe("a-2");
  expect(
    db.query("SELECT COUNT(*) AS n FROM file_snapshots WHERE attempt_id = 'a-0'").get(),
  ).toEqual({ n: 0 });
});

test("a shared hash survives until its last reference is pruned", () => {
  const db = setup();
  for (let i = 0; i < 2; i++) {
    recordSnapshot(db, {
      attemptId: `a-${i}`,
      workspacePath: "/w",
      collector: "git",
      capturedAt: i,
      partial: false,
      entries: [entry("shared.ts", "shared")],
    });
  }
  expect(pruneSnapshots(db, "/w", 1)).toEqual([]); // a-0 rows gone, a-1 still references "shared"
  expect(pruneSnapshots(db, "/w", 1)).toEqual([]); // nothing left to prune
  recordSnapshot(db, {
    attemptId: "a-2",
    workspacePath: "/w",
    collector: "git",
    capturedAt: 2,
    partial: false,
    entries: [entry("other.ts", "other")],
  });
  expect(pruneSnapshots(db, "/w", 1)).toEqual(["shared"]);
});
