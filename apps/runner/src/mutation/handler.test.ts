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
import { migrateRunnerDb, recordSnapshot } from "@cc-web/runner-db";
import { createMutationHandler } from "./handler.ts";

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

function setup(root: string) {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  const handler = createMutationHandler({
    db,
    workspacePathFor: (id) => (id === "default" ? root : undefined),
    homeDir: root,
    spawn: noGit,
  });
  return { db, handler };
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
    await mkdir(join(root, "snapshots", "blobs"), { recursive: true });
    await Bun.write(join(root, "snapshots", "blobs", hash), content);
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
