import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { collectWorkspaceFiles } from "./collect.ts";

const roots: string[] = [];
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cc-web-collect-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

// The git seam is a fake: exitCode 1 makes the collector fall back to the walk.
const noGit = { spawn: async () => ({ exitCode: 1, stdout: "" }) };

test("the walk skips .git and node_modules and sorts its answer", async () => {
  const root = await workspace();
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules", "x"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "b.ts"), "b");
  await writeFile(join(root, "src", "a.ts"), "a");
  await writeFile(join(root, "node_modules", "x", "i.js"), "i");
  const collected = await collectWorkspaceFiles(root, { spawn: noGit.spawn });
  expect(collected.mode).toBe("walk");
  expect(collected.paths).toEqual(["b.ts", "src/a.ts"]);
});

test("credential names and symlinks are excluded, not collected", async () => {
  const root = await workspace();
  await writeFile(join(root, "a.ts"), "a");
  await writeFile(join(root, ".env"), "SECRET=1");
  await symlink(join(root, "a.ts"), join(root, "link.ts"));
  const collected = await collectWorkspaceFiles(root, { spawn: noGit.spawn });
  expect(collected.paths).toEqual(["a.ts"]);
  expect(collected.excluded.map((e) => [e.path, e.reason]).sort()).toEqual([
    [".env", "credential"],
    ["link.ts", "symlink"],
  ]);
});

test("git mode parses NUL-separated paths from ls-files", async () => {
  const root = await workspace();
  await writeFile(join(root, "a.ts"), "a");
  await writeFile(join(root, "b.ts"), "b");
  const spawn = async () => ({ exitCode: 0, stdout: "b.ts\0a.ts\0" });
  const collected = await collectWorkspaceFiles(root, { spawn });
  expect(collected.mode).toBe("git");
  expect(collected.paths).toEqual(["a.ts", "b.ts"]);
});

test("crossing the entry cap truncates instead of silently shrinking", async () => {
  const root = await workspace();
  for (let i = 0; i < 5; i++) await writeFile(join(root, `f-${i}.ts`), "x");
  const collected = await collectWorkspaceFiles(root, { spawn: noGit.spawn, maxEntries: 3 });
  expect(collected.truncated).toBe(true);
  expect(collected.paths).toHaveLength(3);
});
