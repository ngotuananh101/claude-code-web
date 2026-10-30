import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addCustomWorkspace, migrateRunnerDb } from "@cc-web/runner-db";
import { createWorkspaceRegistry } from "./registry.ts";

/**
 * The live registry the daemon resolves workspace ids through (§15.1, §18.2).
 *
 * The case these tests exist for is the one that shipped broken: the run
 * controller persists a custom workspace the first time a `run.start` names
 * one (`addCustomWorkspace`, the §4.1 payload fallback), and the very next
 * inspection of that session has to resolve the id. Cached at boot with no
 * invalidation, the registry answered undefined forever — a session in a
 * freshly browsed folder ran, then the panel reported "Không tìm thấy
 * workspace." until the runner was restarted.
 */

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cc-web-registry-"));
  roots.push(dir);
  return dir;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  return db;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createWorkspaceRegistry", () => {
  test("resolves the default workspace from the environment", async () => {
    const root = await makeRoot();
    const workspace = join(root, "project");
    await mkdir(workspace, { recursive: true });

    const registry = createWorkspaceRegistry({
      defaultEnv: workspace,
      db: freshDb(),
      homeDir: root,
    });

    expect(registry.pathFor("default")).toBe(resolve(workspace));
  });

  test("an id this runner does not serve stays unknown", async () => {
    const root = await makeRoot();
    const registry = createWorkspaceRegistry({ db: freshDb(), homeDir: root });

    expect(registry.pathFor("never-heard-of-it")).toBeUndefined();
  });

  test("a custom workspace persisted after boot resolves without a restart", async () => {
    const root = await makeRoot();
    const db = freshDb();
    const workspace = join(root, "fresh-folder");
    await mkdir(workspace, { recursive: true });

    const registry = createWorkspaceRegistry({ db, homeDir: root });
    // Before the first run.start lands, the id is genuinely unknown.
    expect(registry.pathFor("ws-uuid-1")).toBeUndefined();

    // What RunController does when run.start falls back to payload.workspacePath.
    addCustomWorkspace(db, { workspaceId: "ws-uuid-1", path: workspace });

    expect(registry.pathFor("ws-uuid-1")).toBe(resolve(workspace));
  });

  test("the declaration names a persisted custom workspace, so the server can learn it", async () => {
    const root = await makeRoot();
    const db = freshDb();
    const workspace = join(root, "declared-later");
    await mkdir(workspace, { recursive: true });

    const registry = createWorkspaceRegistry({ db, homeDir: root });
    expect(registry.list()).toEqual([]);

    addCustomWorkspace(db, { workspaceId: "ws-uuid-2", path: workspace });

    expect(registry.list()).toEqual([{ workspaceId: "ws-uuid-2", path: resolve(workspace) }]);
  });

  test("a repeated miss costs a query, not a rescan", async () => {
    const root = await makeRoot();
    const db = freshDb();
    const registry = createWorkspaceRegistry({ db, homeDir: root });

    // The same answer three times, and the discovery list keeps its identity:
    // an id nobody registered must not make every command re-walk the disk.
    expect(registry.pathFor("nope")).toBeUndefined();
    const listed = registry.list();
    expect(registry.pathFor("nope")).toBeUndefined();
    expect(registry.list()).toBe(listed);
  });
});
