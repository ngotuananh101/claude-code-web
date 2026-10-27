import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateRunnerDb, recordSnapshot } from "@cc-web/runner-db";
import { createSnapshotStatus, type StatusOutcome } from "./status.ts";

const roots: string[] = [];

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cc-web-status-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

const noGit = async () => ({ exitCode: 1, stdout: "" });

/** A git seam that reports the given tracked files in `git ls-files` output. */
function gitListing(
  paths: string[],
): (argv: readonly string[], cwd: string) => Promise<{ exitCode: number; stdout: string }> {
  return async (argv) => {
    if (argv[1] === "ls-files") return { exitCode: 0, stdout: `${paths.join("\0")}\0` };
    return { exitCode: 0, stdout: "" };
  };
}

function freshDb(): Database {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  return db;
}

const sha = (s: string) => createHash("sha256").update(Buffer.from(s)).digest("hex");

test("a workspace with no baseline answers baseline: null", async () => {
  const root = await workspace();
  const status = createSnapshotStatus({ db: freshDb(), spawn: noGit });
  expect(await status(root)).toEqual({
    ok: true,
    result: {
      op: "snapshot.status",
      baseline: null,
      entries: [],
      counts: { modified: 0, created: 0, deleted: 0, excluded: 0 },
      digest: null,
      truncated: false,
    },
  });
});

test("classifies modified, created and deleted against the baseline", async () => {
  const root = await workspace();
  const db = freshDb();
  const prevHash = sha("prev\n");
  const byeHash = sha("bye\n");
  recordSnapshot(db, {
    attemptId: "a1",
    workspacePath: root,
    collector: "walk",
    capturedAt: 1_000,
    partial: false,
    entries: [
      { path: "a.txt", state: "kept", hash: prevHash, size: 5, mode: 0o644 },
      { path: "gone.txt", state: "kept", hash: byeHash, size: 4, mode: 0o644 },
    ],
  });

  // Now mutate the workspace: a.txt modified, created.txt added, gone.txt deleted.
  await writeFile(join(root, "a.txt"), "next\n");
  await writeFile(join(root, "created.txt"), "new\n");

  const status = createSnapshotStatus({ db, spawn: noGit });
  const out: StatusOutcome = await status(root);
  expect(out.ok).toBe(true);
  if (!out.ok) throw new Error("expected ok");

  const result = out.result;
  expect(result.op).toBe("snapshot.status");
  expect(result.baseline).toEqual({
    attemptId: "a1",
    sessionId: null,
    capturedAt: new Date(1_000).toISOString(),
    partial: false,
    fileCount: 2,
  });
  expect(result.entries.map((e) => [e.path, e.status])).toEqual([
    ["a.txt", "modified"],
    ["created.txt", "created"],
    ["gone.txt", "deleted"],
  ]);
  expect(result.counts).toEqual({ modified: 1, created: 1, deleted: 1, excluded: 0 });
  expect(result.truncated).toBe(false);
  // A non-null digest is expected (baseline present, not truncated).
  expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
});

test("the digest is stable across identical trees and changes with the content", async () => {
  const root = await workspace();
  const db = freshDb();
  const prevHash = sha("prev\n");
  recordSnapshot(db, {
    attemptId: "a1",
    workspacePath: root,
    collector: "walk",
    capturedAt: 1_000,
    partial: false,
    entries: [{ path: "a.txt", state: "kept", hash: prevHash, size: 5, mode: 0o644 }],
  });
  await writeFile(join(root, "a.txt"), "prev\n");

  const status = createSnapshotStatus({ db, spawn: noGit });
  const first = await status(root);
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("expected ok");
  const second = await status(root);
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error("expected ok");
  expect(first.result.digest).toBe(second.result.digest);

  // Edit the file: digest must change.
  await writeFile(join(root, "a.txt"), "changed\n");
  const third = await status(root);
  expect(third.ok).toBe(true);
  if (!third.ok) throw new Error("expected ok");
  expect(third.result.digest).not.toBe(first.result.digest);
  // The entry is now modified.
  expect(third.result.entries[0]?.status).toBe("modified");
});

test("excluded entries keep their reason and are not revertable", async () => {
  const root = await workspace();
  const db = freshDb();
  const prevHash = sha("prev\n");
  recordSnapshot(db, {
    attemptId: "a1",
    workspacePath: root,
    collector: "walk",
    capturedAt: 1_000,
    partial: false,
    entries: [
      { path: "a.txt", state: "kept", hash: prevHash, size: 5, mode: 0o644 },
      {
        path: "big.txt",
        state: "excluded",
        hash: null,
        size: null,
        mode: null,
        reason: "oversize",
      },
    ],
  });
  await writeFile(join(root, "a.txt"), "prev\n");
  // Current big.txt exceeds MAX_SNAPSHOT_FILE_BYTES (1 MiB), so it is not
  // hashed on the status side but the baseline row carries the reason.
  await writeFile(join(root, "big.txt"), "x".repeat(2_000_000));

  const status = createSnapshotStatus({ db, spawn: noGit });
  const out = await status(root);
  expect(out.ok).toBe(true);
  if (!out.ok) throw new Error("expected ok");

  const bigEntry = out.result.entries.find((e) => e.path === "big.txt");
  expect(bigEntry).toBeDefined();
  expect(bigEntry!.status).toBe("excluded");
  expect(bigEntry!.reason).toBe("oversize");
  expect(bigEntry!.revertable).toBe(false);
});

test("a git baseline with no repository is incomparable", async () => {
  const root = await workspace();
  const db = freshDb();
  const prevHash = sha("prev\n");
  recordSnapshot(db, {
    attemptId: "a1",
    workspacePath: root,
    collector: "git",
    capturedAt: 1_000,
    partial: false,
    entries: [{ path: "a.txt", state: "kept", hash: prevHash, size: 5, mode: 0o644 }],
  });
  await writeFile(join(root, "a.txt"), "prev\n");

  // spawn exits 1 -> collectWorkspaceFiles falls back to "walk" mode -> incomparable.
  const status = createSnapshotStatus({ db, spawn: noGit });
  const out = await status(root);
  expect(out).toEqual({ ok: false, code: "SNAPSHOT_INCOMPARABLE" });
});

test("a git baseline against a git workspace is comparable", async () => {
  const root = await workspace();
  const db = freshDb();
  const prevHash = sha("prev\n");
  recordSnapshot(db, {
    attemptId: "a1",
    workspacePath: root,
    collector: "git",
    capturedAt: 1_000,
    partial: false,
    entries: [{ path: "a.txt", state: "kept", hash: prevHash, size: 5, mode: 0o644 }],
  });
  await writeFile(join(root, "a.txt"), "prev\n");

  const status = createSnapshotStatus({ db, spawn: gitListing(["a.txt"]) });
  const out = await status(root);
  expect(out.ok).toBe(true);
  if (!out.ok) throw new Error("expected ok");
  // Unchanged file (identical hash) -> no entry at all; counts are all zero.
  expect(out.result.entries).toEqual([]);
  expect(out.result.counts).toEqual({ modified: 0, created: 0, deleted: 0, excluded: 0 });
});

test("current symlinks and non-regular files surface as excluded", async () => {
  const root = await workspace();
  const db = freshDb();
  recordSnapshot(db, {
    attemptId: "a1",
    workspacePath: root,
    collector: "walk",
    capturedAt: 1_000,
    partial: false,
    entries: [],
  });
  await writeFile(join(root, "real.txt"), "x\n");
  await symlink(join(root, "real.txt"), join(root, "link.txt"));

  const status = createSnapshotStatus({ db, spawn: noGit });
  const out = await status(root);
  expect(out.ok).toBe(true);
  if (!out.ok) throw new Error("expected ok");
  const linkEntry = out.result.entries.find((e) => e.path === "link.txt");
  expect(linkEntry).toBeDefined();
  expect(linkEntry!.status).toBe("excluded");
  expect(linkEntry!.reason).toBe("symlink");
  expect(linkEntry!.revertable).toBe(false);
});

test("truncation nullifies the digest", async () => {
  const root = await workspace();
  const db = freshDb();
  const prevHash = sha("prev\n");
  // A baseline with one kept entry + a created file on disk -> two merged
  // paths, but maxEntries: 0 caps the first -> truncated, digest null.
  recordSnapshot(db, {
    attemptId: "a1",
    workspacePath: root,
    collector: "walk",
    capturedAt: 1_000,
    partial: false,
    entries: [{ path: "a.txt", state: "kept", hash: prevHash, size: 5, mode: 0o644 }],
  });
  await writeFile(join(root, "b.txt"), "x\n");

  const status = createSnapshotStatus({ db, spawn: noGit, maxEntries: 0 });
  const out = await status(root);
  expect(out.ok).toBe(true);
  if (!out.ok) throw new Error("expected ok");
  expect(out.result.truncated).toBe(true);
  expect(out.result.digest).toBeNull();
});
