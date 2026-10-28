import type { Database as SqliteDb } from "bun:sqlite";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateRunnerDb } from "@cc-web/runner-db";
import {
  type DiscoverOptions,
  declaredWorkspaces,
  defaultWorkspaceResolver,
  discoverWorkspaces,
  workspaceResolverFrom,
} from "./workspaces.ts";

/**
 * The MVP bridge between §11.1's "the user picks a workspace already bound to
 * the runner" and a runner that has no registration flow yet: the operator
 * names one directory in the environment, and the server's default dispatches
 * ("default") land there. Any other workspace id stays unknown, which the run
 * controller refuses honestly rather than guessing a path.
 */

const roots: string[] = [];

async function makeFsRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cc-web-ws-"));
  roots.push(dir);
  return dir;
}

function freshDb(): SqliteDb {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  return db;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Slug an option object omitting keys that are `undefined` (exactOptionalPropertyTypes). */
function opts(base: { defaultEnv?: string; db?: SqliteDb; homeDir?: string }): DiscoverOptions {
  const out: Record<string, unknown> = {};
  if (base.defaultEnv !== undefined) out.defaultEnv = base.defaultEnv;
  if (base.db !== undefined) out.db = base.db;
  if (base.homeDir !== undefined) out.homeDir = base.homeDir;
  return out as DiscoverOptions;
}

describe("default workspace resolver", () => {
  test("an unset or blank environment value maps nothing", () => {
    expect(defaultWorkspaceResolver(undefined)("default")).toBeUndefined();
    expect(defaultWorkspaceResolver("   ")("default")).toBeUndefined();
  });

  test("the environment value answers exactly the default workspace", () => {
    const resolve = defaultWorkspaceResolver("/srv/project");
    expect(resolve("default")).toBe("/srv/project");
  });

  test("other workspace ids stay unknown — no path is invented", () => {
    const resolve = defaultWorkspaceResolver("/srv/project");
    expect(resolve("other")).toBeUndefined();
    expect(resolve("")).toBeUndefined();
  });

  test("a value with surrounding whitespace is used trimmed", () => {
    expect(defaultWorkspaceResolver("  /srv/project  ")("default")).toBe("/srv/project");
  });
});

describe("declaredWorkspaces", () => {
  test("an unset or blank environment value declares nothing", () => {
    expect(declaredWorkspaces(undefined)).toEqual([]);
    expect(declaredWorkspaces("")).toEqual([]);
    expect(declaredWorkspaces("   ")).toEqual([]);
  });

  test("the environment value declares the default workspace at that path", () => {
    expect(declaredWorkspaces("/srv/project")).toEqual([
      { workspaceId: "default", path: "/srv/project" },
    ]);
  });

  test("the declared path is trimmed, matching the resolver", () => {
    expect(declaredWorkspaces("  /srv/project  ")).toEqual([
      { workspaceId: "default", path: "/srv/project" },
    ]);
  });
});

/**
 * discoverWorkspaces merges three sources (§18.2, Task 3):
 *  1. `CC_WEB_RUNNER_DEFAULT_WORKSPACE` as the "default" workspace.
 *  2. custom workspaces persisted in the runner DB.
 *  3. projects discovered under `~/.claude/projects/`, decoded from the
 *     directory naming or read from session `cwd` fields, filtered to paths
 *     that really exist on disk.
 *
 * Each returned workspace has a deterministic, URL-friendly `workspaceId`. The
 * "default" env path keeps its id; other paths are slugged, disambiguated with
 * a short hash on collision. Workspaces dedupe by canonical path.
 */
describe("discoverWorkspaces", () => {
  test("a blank default env and no db and no projects yields nothing", async () => {
    const home = await makeFsRoot();
    expect(discoverWorkspaces(opts({ homeDir: home }))).toEqual([]);
  });

  test("the default env path is declared as workspaceId 'default'", async () => {
    const home = await makeFsRoot();
    const proj = await makeFsRoot();
    expect(discoverWorkspaces(opts({ defaultEnv: proj, homeDir: home }))).toEqual([
      { workspaceId: "default", path: proj },
    ]);
  });

  test("custom workspaces from the db are merged in", async () => {
    const home = await makeFsRoot();
    const db = freshDb();
    const custom = "/srv/custom";
    // addCustomWorkspace uses the given id; discovery must keep persisted ids.
    const { addCustomWorkspace } = await import("@cc-web/runner-db");
    addCustomWorkspace(db, { workspaceId: "custom-1", path: custom }, 1_000);

    const found = discoverWorkspaces(opts({ db, homeDir: home }));
    expect(found).toContainEqual({ workspaceId: "custom-1", path: custom });
  });

  test("projects under ~/.claude/projects are discovered and slugged", async () => {
    const home = await makeFsRoot();
    const projectsRoot = join(home, ".claude", "projects");
    await mkdir(projectsRoot, { recursive: true });

    // Create a real project dir; Claude encodes /mnt/Data/Ponta/cc-web as
    // "-mnt-Data-Ponta-cc-web".
    const projectDir = await makeFsRoot();
    const projectDirName = `/${projectDir.replace(/^\//, "")}`.replace(/\//g, "-");
    const projectEntry = join(projectsRoot, projectDirName);
    await mkdir(projectEntry, { recursive: true });
    // Claude keeps a live .jsonl session file inside the encoded dir.
    await writeFile(
      join(projectEntry, "session.jsonl"),
      JSON.stringify({ type: "system", cwd: projectDir }) + "\n",
    );

    const found = discoverWorkspaces(opts({ homeDir: home }));

    const entry = found.find((w) => w.path === projectDir);
    expect(entry).toBeDefined();
    expect(entry!.workspaceId).not.toBe("default");
    // Slug is URL-friendly: lowercase, no spaces, no slashes.
    expect(entry!.workspaceId).toMatch(/^[a-z0-9-]+$/);
  });

  test("a project discovered dir that does not exist on disk is skipped", async () => {
    const home = await makeFsRoot();
    const projectsRoot = join(home, ".claude", "projects");
    await mkdir(projectsRoot, { recursive: true });

    // An encoded dir pointing at a path that does not exist is filtered out.
    const encoded = "-nonexistent-miss";
    await mkdir(join(projectsRoot, encoded), { recursive: true });

    const found = discoverWorkspaces(opts({ homeDir: home }));
    expect(found.find((w) => w.path === "/nonexistent/miss")).toBeUndefined();
  });

  test("default env path whose dir also appears in projects keeps 'default'", async () => {
    const home = await makeFsRoot();
    const defaultPath = await makeFsRoot();
    const projectsRoot = join(home, ".claude", "projects");
    await mkdir(projectsRoot, { recursive: true });
    const projectDirName = `/${defaultPath.replace(/^\//, "")}`.replace(/\//g, "-");
    await mkdir(join(projectsRoot, projectDirName), { recursive: true });
    await writeFile(
      join(projectsRoot, projectDirName, "session.jsonl"),
      JSON.stringify({ type: "system", cwd: defaultPath }) + "\n",
    );

    const found = discoverWorkspaces(opts({ defaultEnv: defaultPath, homeDir: home }));
    const ids = found.filter((w) => w.path === defaultPath).map((w) => w.workspaceId);
    expect(ids).toEqual(["default"]);
    expect(found).toHaveLength(1);
  });

  test("deduplicates workspaces with the same canonical path", async () => {
    const home = await makeFsRoot();
    const proj = await makeFsRoot();
    // db and default env point at the same path; only one "default" entry.
    const { addCustomWorkspace } = await import("@cc-web/runner-db");
    const db = freshDb();
    addCustomWorkspace(db, { workspaceId: "custom-1", path: proj }, 1_000);

    const found = discoverWorkspaces(opts({ defaultEnv: proj, db, homeDir: home }));
    expect(found.filter((w) => w.path === proj)).toEqual([{ workspaceId: "default", path: proj }]);
  });

  test("colliding slugs are disambiguated with a short hash suffix", async () => {
    const home = await makeFsRoot();
    const projectsRoot = join(home, ".claude", "projects");
    await mkdir(projectsRoot, { recursive: true });

    // Two distinct dirs whose basename slug would collide.
    const dirA = await makeFsRoot();
    const dirB = await makeFsRoot();
    const subA = join(dirA, "project");
    const subB = join(dirB, "project");
    await mkdir(subA);
    await mkdir(subB);
    const encA = `/${subA.replace(/^\//, "")}`.replace(/\//g, "-");
    const encB = `/${subB.replace(/^\//, "")}`.replace(/\//g, "-");
    await mkdir(join(projectsRoot, encA), { recursive: true });
    await mkdir(join(projectsRoot, encB), { recursive: true });
    await writeFile(
      join(projectsRoot, encA, "s.jsonl"),
      JSON.stringify({ type: "system", cwd: subA }) + "\n",
    );
    await writeFile(
      join(projectsRoot, encB, "s.jsonl"),
      JSON.stringify({ type: "system", cwd: subB }) + "\n",
    );

    const found = discoverWorkspaces(opts({ homeDir: home }));
    const a = found.find((w) => w.path === subA);
    const b = found.find((w) => w.path === subB);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.workspaceId).not.toBe(b!.workspaceId);
  });

  test("default env path is normalized with path.resolve", async () => {
    const home = await makeFsRoot();
    const proj = await makeFsRoot();
    const found = discoverWorkspaces(opts({ defaultEnv: `${proj}/`, homeDir: home }));
    expect(found).toEqual([{ workspaceId: "default", path: proj }]);
  });
});

/**
 * workspaceResolverFrom builds an id → path lookup from a declared list.
 * The server dispatches a workspace id; an unknown id resolves to undefined so
 * the run controller can refuse honestly instead of guessing.
 */
describe("workspaceResolverFrom", () => {
  test("resolves a known workspace id to its path", () => {
    const resolve = workspaceResolverFrom([
      { workspaceId: "default", path: "/srv/a" },
      { workspaceId: "web", path: "/srv/b" },
    ]);
    expect(resolve("default")).toBe("/srv/a");
    expect(resolve("web")).toBe("/srv/b");
  });

  test("returns undefined for an unknown id", () => {
    const resolve = workspaceResolverFrom([{ workspaceId: "default", path: "/srv/a" }]);
    expect(resolve("nope")).toBeUndefined();
  });

  test("an empty list resolves nothing", () => {
    expect(workspaceResolverFrom([])("default")).toBeUndefined();
  });

  test("later duplicates win the lookup (deterministic)", () => {
    const resolve = workspaceResolverFrom([
      { workspaceId: "default", path: "/srv/a" },
      { workspaceId: "default", path: "/srv/b" },
    ]);
    expect(resolve("default")).toBe("/srv/b");
  });
});
