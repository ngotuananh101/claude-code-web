import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectWorkspaceFiles, isNeverCollectedPath } from "./collect.ts";

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

test("atomic-write temp files are skipped in the walk, not collected or excluded", async () => {
  const root = await workspace();
  await writeFile(join(root, "a.txt"), "prev\n");
  // Matches the writeAtomic temp-file pattern: .cc-web-<uuid>.tmp
  await writeFile(
    join(root, ".cc-web-2f1c9b1e-8a44-4b7a-9d1e-0123456789ab.tmp"),
    "leftover from a crashed write",
  );
  const collected = await collectWorkspaceFiles(root, { spawn: noGit.spawn });
  expect(collected.paths).toEqual(["a.txt"]);
  expect(collected.excluded).toEqual([]);
  expect(collected.truncated).toBe(false);
});

test("atomic-write temp files are skipped in git mode too", async () => {
  const root = await workspace();
  // git ls-files --cached --others --exclude-standard lists untracked files,
  // so a temp file from a crashed write would appear here if not filtered.
  const spawn = async () => ({
    exitCode: 0,
    stdout: "a.txt\0.cc-web-2f1c9b1e-8a44-4b7a-9d1e-0123456789ab.tmp\0",
  });
  const collected = await collectWorkspaceFiles(root, { spawn });
  expect(collected.mode).toBe("git");
  expect(collected.paths).toEqual(["a.txt"]);
  expect(collected.truncated).toBe(false);
});

test("isNeverCollectedPath flags ignored dirs at any depth and temp-file basenames", () => {
  expect(isNeverCollectedPath(".git/config")).toBe(true);
  expect(isNeverCollectedPath("node_modules/x/y.js")).toBe(true);
  expect(isNeverCollectedPath("sub/node_modules/x.js")).toBe(true);
  expect(isNeverCollectedPath("dist/output.js")).toBe(true);
  expect(isNeverCollectedPath(".cc-web-x.tmp")).toBe(true);
  expect(isNeverCollectedPath("a.txt")).toBe(false);
  expect(isNeverCollectedPath("src/a.ts")).toBe(false);
});

test("a cap-stop with exclusions still reports truncation", async () => {
  // Two symlinks (excluded) plus five regular files in the same directory.
  // With maxEntries 3 the walk hits the combined cap (collected + excluded
  // reaching limit-of-4) before visiting all entries. Regardless of readdir
  // order, the cap-stop must surface as truncated so a later bulk revert
  // refuses rather than deleting unseen files.
  const root = await workspace();
  await symlink(join(root, "f-0.ts"), join(root, "link0.ts"));
  await symlink(join(root, "f-1.ts"), join(root, "link1.ts"));
  for (let i = 0; i < 5; i++) await writeFile(join(root, `f-${i}.ts`), "x");
  const collected = await collectWorkspaceFiles(root, { spawn: noGit.spawn, maxEntries: 3 });
  expect(collected.truncated).toBe(true);
  expect(collected.paths).toHaveLength(3);
});
