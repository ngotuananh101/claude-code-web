import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireWorkspaceLock, migrateRunnerDb, recordSnapshot } from "@cc-web/runner-db";
import { createMutationHandler } from "./handler.ts";
import { computeSnapshotPlan } from "../workspace/status.ts";

const roots: string[] = [];
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cc-web-mutate-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});
const sha = (s: string) => createHash("sha256").update(Buffer.from(s)).digest("hex");

const noGit = async () => ({ exitCode: 1, stdout: "" });

function setup(root: string, homeDir: string = root) {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  const handler = createMutationHandler({
    db,
    workspacePathFor: (id) => (id === "default" ? root : undefined),
    homeDir,
    spawn: noGit,
  });
  return { db, handler, homeDir };
}

const write = (commandId: string, path: string, content: string, expectedHash: string) => ({
  protocolVersion: 1,
  commandId,
  runnerId: "runner-a",
  workspaceId: "default",
  kind: "workspace.file.write",
  payload: { op: "file.write", path, content, expectedHash },
});

async function seedBaseline(
  db: Database,
  root: string,
  attemptId: string,
  files: Record<string, string | null>,
  homeDir: string = root,
) {
  const entries = [];
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      entries.push({
        path,
        state: "excluded" as const,
        hash: null,
        size: null,
        mode: null,
        reason: "oversize",
      });
      continue;
    }
    const hash = sha(content);
    const blobsDir = join(homeDir, "snapshots", "blobs");
    await mkdir(blobsDir, { recursive: true });
    await Bun.write(join(blobsDir, hash), content);
    entries.push({
      path,
      state: "kept" as const,
      hash,
      size: Buffer.byteLength(content),
      mode: 0o644,
    });
  }
  recordSnapshot(db, {
    attemptId,
    workspacePath: root,
    collector: "walk",
    capturedAt: 1,
    partial: false,
    entries,
  });
}

const revert = (commandId: string, path: string, expectedHash: string | null) => ({
  protocolVersion: 1,
  commandId,
  runnerId: "runner-a",
  workspaceId: "default",
  kind: "workspace.file.revert",
  payload: { op: "file.revert", path, expectedHash },
});

test("saves when the expected hash matches and returns the new token", async () => {
  const root = await workspace();
  await writeFile(join(root, "a.txt"), "prev\n");
  const { handler } = setup(root);
  const frame = await handler(write("c1", "a.txt", "next\n", sha("prev\n")));
  expect(frame.ok).toBe(true);
  expect(frame.result).toEqual({ op: "file.write", path: "a.txt", hash: sha("next\n"), size: 5 });
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("next\n");
  expect((await readdir(root)).sort()).toEqual(["a.txt"]); // no temp file left
});

test("a stale token is a conflict and changes nothing", async () => {
  const root = await workspace();
  await writeFile(join(root, "a.txt"), "prev\n");
  const { handler } = setup(root);
  const frame = await handler(write("c1", "a.txt", "next\n", "stale"));
  expect(frame).toEqual({
    type: "rpc.result",
    commandId: "c1",
    ok: false,
    error: { code: "FILE_CONFLICT", message: expect.any(String) },
  });
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("prev\n");
});

test("a run holding the workspace lock refuses the save", async () => {
  const root = await workspace();
  await writeFile(join(root, "a.txt"), "prev\n");
  const { db, handler } = setup(root);
  db.query("INSERT INTO workspace_locks VALUES (?, ?, ?)").run(root, "attempt-1", 1);
  const frame = await handler(write("c1", "a.txt", "next\n", sha("prev\n")));
  expect(frame.ok).toBe(false);
  expect(frame.error?.code).toBe("WORKSPACE_BUSY");
});

test("symlinks, credential names, missing files and binary targets are refused", async () => {
  const root = await workspace();
  await writeFile(join(root, "a.txt"), "prev\n");
  await writeFile(join(root, ".env"), "SECRET=1");
  await symlink(join(root, "a.txt"), join(root, "link.txt"));
  await writeFile(join(root, "bin.dat"), Buffer.from([1, 0, 2]));
  const { handler } = setup(root);
  const code = async (path: string) =>
    (await handler(write("c", path, "x", "whatever"))).error?.code;
  expect(await code("link.txt")).toBe("SYMLINK_REFUSED");
  expect(await code(".env")).toBe("CREDENTIAL_FILE_REFUSED");
  expect(await code("missing.txt")).toBe("FILE_NOT_FOUND");
  expect(await code("bin.dat")).toBe("FILE_UNSUPPORTED");
  expect(await code("../x.txt")).toBe("PATH_OUTSIDE_WORKSPACE");
});

test("content over the per-file cap is refused before any write", async () => {
  const root = await workspace();
  await writeFile(join(root, "a.txt"), "prev\n");
  const { handler } = setup(root);
  const big = "x".repeat(1024 * 1024 + 1);
  const frame = await handler(write("c1", "a.txt", big, sha("prev\n")));
  expect(frame.error?.code).toBe("FILE_UNSUPPORTED");
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("prev\n");
});

test("the file's permission bits survive the atomic write", async () => {
  const root = await workspace();
  await writeFile(join(root, "a.txt"), "prev\n");
  await chmod(join(root, "a.txt"), 0o640);
  const { handler } = setup(root);
  await handler(write("c1", "a.txt", "next\n", sha("prev\n")));
  expect((await stat(join(root, "a.txt"))).mode & 0o777).toBe(0o640);
});

test("restores the baseline bytes when the current hash matches", async () => {
  const root = await workspace();
  await mkdir(join(root, "snapshots", "blobs"), { recursive: true });
  const { db, handler } = setup(root);
  await seedBaseline(db, root, "a-1", { "a.txt": "prev\n" });
  await writeFile(join(root, "a.txt"), "next\n");
  const frame = await handler(revert("c1", "a.txt", sha("next\n")));
  expect(frame.result).toEqual({
    op: "file.revert",
    path: "a.txt",
    action: "restored",
    hash: sha("prev\n"),
    size: 5,
  });
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("prev\n");
});

test("deletes a file that did not exist at run start", async () => {
  const root = await workspace();
  const { db, handler } = setup(root);
  await seedBaseline(db, root, "a-1", { "a.txt": "prev\n" });
  await writeFile(join(root, "created.txt"), "agent\n");
  const frame = await handler(revert("c1", "created.txt", sha("agent\n")));
  expect(frame.result).toEqual({
    op: "file.revert",
    path: "created.txt",
    action: "deleted",
    hash: null,
    size: null,
  });
  await expect(readFile(join(root, "created.txt"), "utf8")).rejects.toThrow();
});

test("a path absent now and at run start is a no-op", async () => {
  const root = await workspace();
  const { db, handler } = setup(root);
  await seedBaseline(db, root, "a-1", { "a.txt": "prev\n" });
  expect((await handler(revert("c1", "gone.txt", null))).result).toEqual({
    op: "file.revert",
    path: "gone.txt",
    action: "none",
    hash: null,
    size: null,
  });
});

test("a hash mismatch is a conflict and the file is untouched", async () => {
  const root = await workspace();
  const { db, handler } = setup(root);
  await seedBaseline(db, root, "a-1", { "a.txt": "prev\n" });
  await writeFile(join(root, "a.txt"), "next\n");
  expect((await handler(revert("c1", "a.txt", "stale"))).error?.code).toBe("FILE_CONFLICT");
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("next\n");
});

test("no baseline, excluded entries and a held lock are refusals", async () => {
  const root = await workspace();
  const { db, handler } = setup(root);
  expect((await handler(revert("c1", "a.txt", null))).error?.code).toBe("NO_SNAPSHOT");
  await seedBaseline(db, root, "a-1", { "big.bin": null });
  expect((await handler(revert("c2", "big.bin", null))).error?.code).toBe("FILE_UNSUPPORTED");
  db.query("INSERT OR REPLACE INTO workspace_locks VALUES (?, ?, ?)").run(root, "attempt-1", 1);
  expect((await handler(revert("c3", "a.txt", null))).error?.code).toBe("WORKSPACE_BUSY");
});

test("expectedHash null with a present kept file is a conflict and untouched", async () => {
  const root = await workspace();
  const { db, handler } = setup(root);
  await seedBaseline(db, root, "a-1", { "a.txt": "prev\n" });
  await writeFile(join(root, "a.txt"), "next\n");
  expect((await handler(revert("c1", "a.txt", null))).error?.code).toBe("FILE_CONFLICT");
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("next\n");
});

test("never-collected paths (.git, .cc-web-.tmp) are refused even with no entry", async () => {
  const root = await workspace();
  const { db, handler } = setup(root);
  await seedBaseline(db, root, "a-1", { "a.txt": "prev\n" });
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, ".git", "config"), "repo-config");
  await writeFile(join(root, ".cc-web-x.tmp"), "leftover");
  expect((await handler(revert("c1", ".git/config", sha("repo-config")))).error?.code).toBe(
    "FILE_UNSUPPORTED",
  );
  expect((await handler(revert("c2", ".cc-web-x.tmp", sha("leftover")))).error?.code).toBe(
    "FILE_UNSUPPORTED",
  );
  expect(await readFile(join(root, ".git", "config"), "utf8")).toBe("repo-config");
  expect(await readFile(join(root, ".cc-web-x.tmp"), "utf8")).toBe("leftover");
});

test("nested never-collected paths (sub/node_modules) are refused", async () => {
  const root = await workspace();
  const { db, handler } = setup(root);
  await seedBaseline(db, root, "a-1", { "a.txt": "prev\n" });
  await mkdir(join(root, "sub", "node_modules"), { recursive: true });
  await writeFile(join(root, "sub", "node_modules", "x.js"), "dep");
  expect((await handler(revert("c1", "sub/node_modules/x.js", sha("dep")))).error?.code).toBe(
    "FILE_UNSUPPORTED",
  );
  expect(await readFile(join(root, "sub", "node_modules", "x.js"), "utf8")).toBe("dep");
});

const apply = (commandId: string, planDigest: string) => ({
  protocolVersion: 1,
  commandId,
  runnerId: "runner-a",
  workspaceId: "default",
  kind: "workspace.revert",
  payload: { op: "workspace.revert", planDigest },
});

async function planDigestFor(db: Database, root: string) {
  const computed = await computeSnapshotPlan({ db, spawn: noGit }, root);
  if ("code" in computed) throw new Error(computed.code);
  return computed.plan.digest!;
}

/** A separate runner home dir so content-addressed blobs live outside the workspace root. */
async function homeDirFor(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cc-web-home-"));
  roots.push(dir);
  return dir;
}

test("applies a matching plan: restores what changed, deletes what was created", async () => {
  const root = await workspace();
  const homeDir = await homeDirFor();
  const { db, handler } = setup(root, homeDir);
  await seedBaseline(db, root, "a-1", { "a.txt": "prev\n" }, homeDir);
  await writeFile(join(root, "a.txt"), "next\n");
  await writeFile(join(root, "created.txt"), "new\n");
  const digest = await planDigestFor(db, root);

  const frame = await handler(apply("c1", digest));
  expect(frame.ok).toBe(true);
  expect(frame.result).toEqual({
    op: "workspace.revert",
    planDigest: digest,
    restored: 1,
    deleted: 1,
    failed: null,
  });
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("prev\n");
  await expect(readFile(join(root, "created.txt"), "utf8")).rejects.toThrow();
  // Lock released.
  expect((await import("@cc-web/runner-db")).lockHolder(db, root)).toBeUndefined();
});

test("a stale plan applies nothing", async () => {
  const root = await workspace();
  const homeDir = await homeDirFor();
  const { db, handler } = setup(root, homeDir);
  await seedBaseline(db, root, "a-1", { "a.txt": "prev\n" }, homeDir);
  await writeFile(join(root, "a.txt"), "next\n");
  const digest = await planDigestFor(db, root);
  // Diverge the tree after the digest was computed.
  await writeFile(join(root, "a.txt"), "changed\n");

  const frame = await handler(apply("c1", digest));
  expect(frame.ok).toBe(false);
  expect(frame.error?.code).toBe("REVERT_STALE");
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("changed\n");
});

test("a partial baseline refuses the bulk revert", async () => {
  const root = await workspace();
  const homeDir = await homeDirFor();
  const { db, handler } = setup(root, homeDir);
  // Seed a snapshot marked partial via recordSnapshot's partial flag. The manifest
  // mode is null to exercise the 0o644 default path (Ruling 1).
  const prevHash = sha("prev\n");
  await mkdir(join(homeDir, "snapshots", "blobs"), { recursive: true });
  await Bun.write(join(homeDir, "snapshots", "blobs", prevHash), "prev\n");
  recordSnapshot(db, {
    attemptId: "a-1",
    workspacePath: root,
    collector: "walk",
    capturedAt: 1,
    partial: true,
    entries: [{ path: "a.txt", state: "kept" as const, hash: prevHash, size: 5, mode: null }],
  });
  await writeFile(join(root, "a.txt"), "next\n");
  const digest = await planDigestFor(db, root);

  const frame = await handler(apply("c1", digest));
  expect(frame.ok).toBe(false);
  expect(frame.error?.code).toBe("SNAPSHOT_PARTIAL");
});

test("a plan over the file budget refuses", async () => {
  const root = await workspace();
  const homeDir = await homeDirFor();
  const { db, handler } = setup(root, homeDir);
  await seedBaseline(db, root, "a-1", { "a.txt": "prev\n" }, homeDir);
  for (let i = 0; i < 301; i++) await writeFile(join(root, `f${i}.txt`), "new\n");
  const digest = await planDigestFor(db, root);

  const frame = await handler(apply("c1", digest));
  expect(frame.ok).toBe(false);
  expect(frame.error?.code).toBe("PLAN_TOO_LARGE");
});

test("a stale and over-budget plan refuses PLAN_TOO_LARGE, not REVERT_STALE", async () => {
  const root = await workspace();
  const homeDir = await homeDirFor();
  const { db, handler } = setup(root, homeDir);
  await seedBaseline(db, root, "a-1", { "a.txt": "prev\n" }, homeDir);
  // Compute the digest while the tree matches the baseline, then diverge AND push the
  // plan over the file budget so the plan is simultaneously stale and over budget.
  await writeFile(join(root, "a.txt"), "next\n");
  const digest = await planDigestFor(db, root);
  for (let i = 0; i < 301; i++) await writeFile(join(root, `f${i}.txt`), "new\n");

  const frame = await handler(apply("c1", digest));
  expect(frame.ok).toBe(false);
  // §7.8 ordering: budget is checked before the digest comparison, so an over-budget
  // plan refuses PLAN_TOO_LARGE even though it is also stale.
  expect(frame.error?.code).toBe("PLAN_TOO_LARGE");
});

test("a held lock refuses the apply and names the holder", async () => {
  const root = await workspace();
  const homeDir = await homeDirFor();
  const { db, handler } = setup(root, homeDir);
  await seedBaseline(db, root, "a-1", { "a.txt": "prev\n" }, homeDir);
  await writeFile(join(root, "a.txt"), "next\n");
  const digest = await planDigestFor(db, root);
  acquireWorkspaceLock(db, root, "revert:holder-x");

  const frame = await handler(apply("c1", digest));
  expect(frame.ok).toBe(false);
  expect(frame.error?.code).toBe("WORKSPACE_BUSY");
  expect(frame.error?.message).toMatch(/holder-x/);
});

test("files the collector excludes are never deleted", async () => {
  const root = await workspace();
  const homeDir = await homeDirFor();
  const { db, handler } = setup(root, homeDir);
  await seedBaseline(db, root, "a-1", { "a.txt": "prev\n" }, homeDir);
  await writeFile(join(root, "a.txt"), "next\n");
  await writeFile(join(root, ".env"), "SECRET=1");
  await mkdir(join(root, "node_modules"), { recursive: true });
  await writeFile(join(root, "node_modules", "x.js"), "dep");
  const digest = await planDigestFor(db, root);

  const frame = await handler(apply("c1", digest));
  expect(frame.ok).toBe(true);
  expect(frame.result).toEqual({
    op: "workspace.revert",
    planDigest: digest,
    restored: 1,
    deleted: 0,
    failed: null,
  });
  expect(await readFile(join(root, ".env"), "utf8")).toBe("SECRET=1");
  expect(await readFile(join(root, "node_modules", "x.js"), "utf8")).toBe("dep");
});
