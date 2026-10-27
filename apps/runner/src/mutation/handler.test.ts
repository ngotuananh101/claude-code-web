import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateRunnerDb } from "@cc-web/runner-db";
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
