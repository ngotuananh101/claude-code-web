# P3-B Writes, Revert, and Run-Start Snapshots — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the workspace panel an editor with a real undo: revision-checked save, per-file revert, and whole-workspace revert to the snapshot captured when the latest run started.

**Architecture:** A new `mutation` command lane (declared kinds `workspace.file.write`, `workspace.file.revert`, plus a new `workspace.revert`) rides the same bounded RPC spine P3-A built (`rpc.result`, in-memory waiters, outbox retirement). The runner captures a content-addressed file baseline after the branch gate and before the SDK starts, stores the manifest in `runner-db`, and serves status/revert from it. The server adds four HTTP routes; the web panel gains a textarea editor and a baseline switch in the Changes tab.

**Tech Stack:** Bun 1.4.3, TypeScript 7, `bun:sqlite`, Vue 3 + Tailwind, Biome, `bun test`.

**Spec:** `docs/superpowers/specs/2026-10-27-p3b-writes-revert-snapshots-design.md`

## Global Constraints

- Code, comments, identifiers, commit messages: **English**. UI copy: **Vietnamese**, matching the existing panel's tone.
- Never edit, lint or format generated shadcn-vue files: `apps/web/src/components/ui/**`, `apps/web/src/lib/utils.ts`, `apps/web/src/styles/index.css`, `apps/web/components.json`.
- TDD every task: write the failing test, run it and see it fail for the right reason, implement, see it pass, commit. One commit per task.
- Do not commit `TODO.md`, `.superpowers/`, `design.md`, or anything under `/tmp`.
- Caps and retention values (from the spec, verbatim): `MAX_SNAPSHOT_FILE_BYTES = 1 MiB`, `MAX_SNAPSHOT_BYTES = 64 MiB`, `MAX_SNAPSHOT_ENTRIES = 10_000`, `MAX_STATUS_ENTRIES = 2_000`, `MAX_REVERT_FILES = 300`, `MAX_REVERT_BYTES = 16 MiB`, `SNAPSHOT_RETENTION = 5`, HTTP body cap `2 MiB`.
- Gates after every task: `bun test <files>`; before each commit run the touched package's suite. Full gates at the end: `bun test`, `bun run typecheck`, `bun run lint`, `bun run test:integration`, `cd apps/web && bun run build`.
- Hash = SHA-256 hex of the exact file bytes, matching `FileReadResult.hash`.
- Revert must never run `git reset --hard` / `git clean`; writes never follow symlinks; credential basenames are never written, snapshotted or deleted.

## Review Focus

These failure modes are the ones most likely to bite a user; each has a test in the named task.

1. **A save races the agent** — bytes changed since the operator read them. Expected: `409 FILE_CONFLICT`, file untouched, hash token re-read (Task 7).
2. **A whole-workspace revert goes stale** — a file edited between preview and apply. Expected: `409 REVERT_STALE`, nothing applied (Task 10).
3. **Pre-existing files outside the collector's rules** (credentials, `node_modules`, symlinks, `.git`) are mistaken for run-created files and deleted. Expected: never in the delete set, never deleted (Tasks 4 and 10).
4. **A symlink points outside the workspace** and a save follows it. Expected: `SYMLINK_REFUSED`, nothing written outside the root (Task 7).
5. **A huge or partial baseline** silently produces a wrong "revert everything". Expected: `SNAPSHOT_PARTIAL` / `PLAN_TOO_LARGE` for the workspace revert, per-file revert still works for complete entries (Tasks 9 and 10).

---

## Task 1: Protocol — mutation types, snapshot status, capability

**Files:**
- Create: `packages/protocol/src/mutation.ts`
- Create: `packages/protocol/src/mutation.test.ts`
- Modify: `packages/protocol/src/inspection.ts` (request/result/frame unions, parser branch)
- Modify: `packages/protocol/src/index.ts` (CommandKind, re-export)
- Test: `packages/protocol/src/inspection.test.ts` (extend if it exists, else the new test file covers the parser)

**Interfaces:**
- Consumes: nothing (leaf package).
- Produces: `WRITE_CAPABILITY`, `MAX_SNAPSHOT_FILE_BYTES`, `MAX_SNAPSHOT_BYTES`, `MAX_SNAPSHOT_ENTRIES`, `MAX_STATUS_ENTRIES`, `MAX_REVERT_FILES`, `MAX_REVERT_BYTES`, `SNAPSHOT_RETENTION`, `FileWriteRequest`, `FileRevertRequest`, `WorkspaceRevertRequest`, `MutationRequest`, `parseMutationRequest(kind, payload)`, `FileWriteResult`, `FileRevertResult`, `WorkspaceRevertResult`, `MutationResult`; in `inspection.ts`: `SnapshotStatusRequest`, `SnapshotEntry`, `SnapshotStatusResult`; `RpcResultFrame.result` widened to `InspectResult | MutationResult`; `"workspace.revert"` added to `CommandKind`.

- [ ] **Step 1: Write the failing tests** in `packages/protocol/src/mutation.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { parseInspectRequest, parseRpcResultFrame } from "./inspection.ts";
import { parseMutationRequest } from "./mutation.ts";

test("parses file.write with all three fields", () => {
  expect(
    parseMutationRequest("workspace.file.write", {
      op: "file.write", path: "src/a.ts", content: "next\n", expectedHash: "abc",
    }),
  ).toEqual({ op: "file.write", path: "src/a.ts", content: "next\n", expectedHash: "abc" });
});

test("refuses file.write with a non-string field", () => {
  expect(
    parseMutationRequest("workspace.file.write", { op: "file.write", path: "a", content: 1, expectedHash: "x" }),
  ).toBeUndefined();
  expect(
    parseMutationRequest("workspace.file.write", { op: "file.write", path: "a", content: "x" }),
  ).toBeUndefined();
});

test("file.revert accepts an absent-file assertion", () => {
  expect(
    parseMutationRequest("workspace.file.revert", { op: "file.revert", path: "new.ts", expectedHash: null }),
  ).toEqual({ op: "file.revert", path: "new.ts", expectedHash: null });
});

test("refuses an op under the wrong kind", () => {
  expect(parseMutationRequest("workspace.file.write", { op: "file.revert", path: "a", expectedHash: null }))
    .toBeUndefined();
  expect(parseMutationRequest("nope", { op: "file.write", path: "a", content: "", expectedHash: "" }))
    .toBeUndefined();
});

test("parses workspace.revert with a digest", () => {
  expect(parseMutationRequest("workspace.revert", { op: "workspace.revert", planDigest: "d1" }))
    .toEqual({ op: "workspace.revert", planDigest: "d1" });
  expect(parseMutationRequest("workspace.revert", { op: "workspace.revert", planDigest: "" }))
    .toBeUndefined();
});

test("snapshot.status is an inspect op and not a mutation op", () => {
  expect(parseInspectRequest("workspace.inspect", { op: "snapshot.status" })).toEqual({ op: "snapshot.status" });
  expect(parseInspectRequest("config.inspect", { op: "snapshot.status" })).toBeUndefined();
  expect(parseMutationRequest("workspace.inspect", { op: "snapshot.status" })).toBeUndefined();
});

test("an rpc.result may carry a mutation result", () => {
  const frame = parseRpcResultFrame({
    type: "rpc.result", commandId: "c1", ok: true,
    result: { op: "file.write", path: "a.ts", hash: "h", size: 3 },
  });
  expect(frame).toEqual({
    type: "rpc.result", commandId: "c1", ok: true,
    result: { op: "file.write", path: "a.ts", hash: "h", size: 3 },
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/protocol/src/mutation.test.ts`
Expected: FAIL — `Cannot find module "./mutation.ts"`.

- [ ] **Step 3: Implement**

`packages/protocol/src/mutation.ts`:

```ts
export const WRITE_CAPABILITY = "workspace.write" as const;
export const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const MAX_SNAPSHOT_ENTRIES = 10_000;
export const MAX_STATUS_ENTRIES = 2000;
export const MAX_REVERT_FILES = 300;
export const MAX_REVERT_BYTES = 16 * 1024 * 1024;
export const SNAPSHOT_RETENTION = 5;

export type FileWriteRequest = { op: "file.write"; path: string; content: string; expectedHash: string };
export type FileRevertRequest = { op: "file.revert"; path: string; expectedHash: string | null };
export type WorkspaceRevertRequest = { op: "workspace.revert"; planDigest: string };
export type MutationRequest = FileWriteRequest | FileRevertRequest | WorkspaceRevertRequest;

export type FileWriteResult = { op: "file.write"; path: string; hash: string; size: number };
export type FileRevertResult = {
  op: "file.revert"; path: string;
  action: "restored" | "deleted" | "none";
  hash: string | null; size: number | null;
};
export type WorkspaceRevertResult = {
  op: "workspace.revert"; planDigest: string;
  restored: number; deleted: number;
  failed: { path: string; code: string } | null;
};
export type MutationResult = FileWriteResult | FileRevertResult | WorkspaceRevertResult;

export function parseMutationRequest(kind: string, payload: unknown): MutationRequest | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const op = record["op"];
  if (kind === "workspace.file.write" && op === "file.write") {
    const path = record["path"], content = record["content"], expectedHash = record["expectedHash"];
    if (typeof path !== "string" || typeof content !== "string" || typeof expectedHash !== "string") {
      return undefined;
    }
    return { op, path, content, expectedHash };
  }
  if (kind === "workspace.file.revert" && op === "file.revert") {
    const path = record["path"], expectedHash = record["expectedHash"];
    if (typeof path !== "string") return undefined;
    if (expectedHash !== null && typeof expectedHash !== "string") return undefined;
    return { op, path, expectedHash };
  }
  if (kind === "workspace.revert" && op === "workspace.revert") {
    const planDigest = record["planDigest"];
    if (typeof planDigest !== "string" || planDigest === "") return undefined;
    return { op, planDigest };
  }
  return undefined;
}
```

In `inspection.ts`: add `{ op: "snapshot.status" }` to `WorkspaceInspectRequest`; add `SnapshotEntry` and `SnapshotStatusResult` exactly as the spec §7.1 defines them (status union `modified|created|deleted|excluded`, counts object, `digest: string | null`, `truncated`); add `SnapshotStatusResult` to `InspectResult`; import `type MutationResult` from `./mutation.ts` and change `RpcResultFrame.result?: InspectResult | MutationResult` and the cast at line 202 to `result as InspectResult | MutationResult`; in `parseInspectRequest`'s `workspace.inspect` branch add `if (op === "snapshot.status") return { op: "snapshot.status" };`.

In `index.ts`: add `"workspace.revert"` to `CommandKind`; add `export * from "./mutation.ts";`.

- [ ] **Step 4: Run and watch it pass**

Run: `bun test packages/protocol` then `bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/mutation.ts packages/protocol/src/mutation.test.ts packages/protocol/src/inspection.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): declare the mutation lane and snapshot status"
```

---

## Task 2: Control-db — the outbox knows `workspace.revert`

**Files:**
- Modify: `packages/control-db/src/command-outbox.ts:26-33`
- Test: `packages/control-db/src/command-outbox.test.ts`

**Interfaces:**
- Consumes: `CommandKind` from Task 1 conceptually (the two unions are kept in sync by hand; each package owns its copy).
- Produces: the outbox accepts and round-trips a `workspace.revert` row.

- [ ] **Step 1: Write the failing test** (add to the existing `command-outbox.test.ts`)

```ts
test("a workspace.revert row round-trips through the outbox", async () => {
  const db = setup();                       // the file's existing helper
  const outbox = new CommandOutbox(db);
  await outbox.enqueue({
    commandId: "c-revert", runnerId: "r-1", kind: "workspace.revert",
    payload: { op: "workspace.revert", planDigest: "d1" },
    issuedAt: new Date(0).toISOString(), workspaceId: "default",
  });
  const row = db.query("SELECT kind, payload FROM command_outbox WHERE command_id = ?").get("c-revert") as
    { kind: string; payload: string };
  expect(row.kind).toBe("workspace.revert");
  expect(JSON.parse(row.payload)).toEqual({ op: "workspace.revert", planDigest: "d1" });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/control-db/src/command-outbox.test.ts`
Expected: FAIL — the test file compiles but the union rejects `"workspace.revert"` (biome/tsc) or the row assertion fails; confirm the failure is the missing kind, not setup.

- [ ] **Step 3: Implement** — add `| "workspace.revert"` to the `CommandKind` union in `command-outbox.ts`.

- [ ] **Step 4: Run it and watch it pass**

Run: `bun test packages/control-db` and `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/control-db/src/command-outbox.ts packages/control-db/src/command-outbox.test.ts
git commit -m "feat(control-db): accept the workspace.revert command kind"
```

---

## Task 3: Runner-db — snapshot tables, queries, retention, lock sentinel

**Files:**
- Modify: `packages/runner-db/src/db.ts` (two tables + index)
- Create: `packages/runner-db/src/snapshots.ts`
- Create: `packages/runner-db/src/snapshots.test.ts`
- Modify: `packages/runner-db/src/attempts.ts` (`acquireWorkspaceLock`)
- Modify: `packages/runner-db/src/attempts.test.ts`
- Modify: `packages/runner-db/src/index.ts` (exports)

**Interfaces:**
- Consumes: `Database`, `migrateRunnerDb`.
- Produces:
  - `recordSnapshot(db, input: SnapshotRunInput): void`
  - `latestSnapshot(db, workspacePath): { run: SnapshotRun; entries: StoredSnapshotEntry[] } | undefined`
  - `pruneSnapshots(db, workspacePath, keep: number): string[]` (hashes no longer referenced anywhere)
  - `acquireWorkspaceLock(db, workspacePath, holderId, now?): boolean`

- [ ] **Step 1: Write the failing tests**

`packages/runner-db/src/snapshots.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrateRunnerDb } from "./db.ts";
import { latestSnapshot, pruneSnapshots, recordSnapshot } from "./snapshots.ts";

function setup() {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  return db;
}

const entry = (path: string, hash: string) =>
  ({ path, state: "kept" as const, hash, size: 4, mode: 0o644 });

test("the newest baseline wins and its entries come back sorted", () => {
  const db = setup();
  recordSnapshot(db, {
    attemptId: "a-old", workspacePath: "/w", collector: "git", capturedAt: 1, partial: false,
    entries: [entry("b.ts", "h2"), entry("a.ts", "h1")],
  });
  recordSnapshot(db, {
    attemptId: "a-new", workspacePath: "/w", collector: "walk", capturedAt: 2, partial: true,
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
      attemptId: `a-${i}`, workspacePath: "/w", collector: "git", capturedAt: i, partial: false,
      entries: [entry(`f-${i}.ts`, `h-${i}`), entry("shared.ts", "shared")],
    });
  }
  const dropped = pruneSnapshots(db, "/w", 2);
  expect(dropped.sort()).toEqual(["h-0"]);
  expect(latestSnapshot(db, "/w")?.run.attemptId).toBe("a-2");
  expect(db.query("SELECT COUNT(*) AS n FROM file_snapshots WHERE attempt_id = 'a-0'").get())
    .toEqual({ n: 0 });
});

test("a shared hash survives until its last reference is pruned", () => {
  const db = setup();
  for (let i = 0; i < 2; i++) {
    recordSnapshot(db, {
      attemptId: `a-${i}`, workspacePath: "/w", collector: "git", capturedAt: i, partial: false,
      entries: [entry("shared.ts", "shared")],
    });
  }
  expect(pruneSnapshots(db, "/w", 1)).toEqual([]);   // a-0 rows gone, a-1 still references "shared"
  expect(pruneSnapshots(db, "/w", 1)).toEqual([]);   // nothing left to prune
  recordSnapshot(db, {
    attemptId: "a-2", workspacePath: "/w", collector: "git", capturedAt: 2, partial: false,
    entries: [entry("other.ts", "other")],
  });
  expect(pruneSnapshots(db, "/w", 1)).toEqual(["shared"]);
});
```

In `packages/runner-db/src/attempts.test.ts` add:

```ts
test("a sentinel holder blocks a run start and names itself", () => {
  const db = setup();                       // the file's existing helper
  expect(acquireWorkspaceLock(db, "/w", "revert:c1")).toBe(true);
  const begun = beginAttempt(db, { attemptId: "a-1", sessionId: "s", runId: "r", workspacePath: "/w" });
  expect(begun).toEqual({ ok: false, reason: "workspace_locked", holderAttemptId: "revert:c1" });
  expect(acquireWorkspaceLock(db, "/w", "revert:c1")).toBe(true);   // idempotent for the holder
  expect(acquireWorkspaceLock(db, "/w", "revert:c2")).toBe(false);  // second mutation refused
  releaseAttempt(db, "revert:c1");
  expect(beginAttempt(db, { attemptId: "a-1", sessionId: "s", runId: "r", workspacePath: "/w" }))
    .toEqual({ ok: true });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test packages/runner-db/src/snapshots.test.ts packages/runner-db/src/attempts.test.ts`
Expected: FAIL — `./snapshots.ts` missing; `acquireWorkspaceLock` not exported.

- [ ] **Step 3: Implement**

`db.ts`: append the two `CREATE TABLE IF NOT EXISTS` statements and the hash index exactly as the spec §7.2 shows, after `registered_workspaces`.

`snapshots.ts`: SQL in one transaction for `recordSnapshot` (insert run + entries); `latestSnapshot` = `ORDER BY captured_at DESC, attempt_id DESC LIMIT 1` then entries `ORDER BY path`; `pruneSnapshots` deletes runs outside the newest `keep`, deletes their entries, then returns `SELECT DISTINCT hash FROM file_snapshots WHERE hash IS NOT NULL` candidates that no longer appear — implement as: collect hashes owned by deleted rows, delete rows, then keep only candidates absent from `SELECT 1 FROM file_snapshots WHERE hash = ?`.

`attempts.ts`:

```ts
export function acquireWorkspaceLock(
  db: Database, workspacePath: string, holderId: string, now: number = Date.now(),
): boolean {
  const tx = db.transaction(() => {
    const row = db.prepare("SELECT attempt_id FROM workspace_locks WHERE workspace_path = ?")
      .get(workspacePath) as { attempt_id: string } | null;
    if (row !== null) return row.attempt_id === holderId;
    db.prepare("INSERT INTO workspace_locks (workspace_path, attempt_id, acquired_at) VALUES (?, ?, ?)")
      .run(workspacePath, holderId, now);
    return true;
  });
  return tx();
}
```

Export it (and the snapshot API) from `index.ts`.

- [ ] **Step 4: Run and watch them pass**

Run: `bun test packages/runner-db` and `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/runner-db/src/db.ts packages/runner-db/src/snapshots.ts packages/runner-db/src/snapshots.test.ts packages/runner-db/src/attempts.ts packages/runner-db/src/attempts.test.ts packages/runner-db/src/index.ts
git commit -m "feat(runner-db): store run-start snapshots and mutation lock holders"
```

---

## Task 4: Runner — relocate path helpers, add the workspace collector

**Files:**
- Move: `apps/runner/src/inspection/paths.ts` → `apps/runner/src/workspace/paths.ts` (and its test)
- Modify: `apps/runner/src/inspection/handler.ts` (import), `apps/runner/src/inspection/handler.test.ts` if it imports paths
- Create: `apps/runner/src/workspace/collect.ts`, `apps/runner/src/workspace/collect.test.ts`

**Interfaces:**
- Consumes: `GitSpawn`, `isRefusedCredentialBasename`.
- Produces: `collectWorkspaceFiles(root, { spawn, maxEntries? }): Promise<Collected>` with `Collected = { mode: "git" | "walk"; paths: string[]; excluded: Array<{ path: string; reason: "credential" | "symlink" | "non_regular" }>; truncated: boolean }`.

- [ ] **Step 1: Move the file**

Use `git mv apps/runner/src/inspection/paths.ts apps/runner/src/workspace/paths.ts` and the same for `paths.test.ts`; update every import (`apps/runner/src/inspection/handler.ts` and any test). Run `bun test apps/runner` — expected: PASS with no other change. Commit this move together with the collector (one task, one commit).

- [ ] **Step 2: Write the failing collector tests** in `apps/runner/src/workspace/collect.test.ts`

```ts
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
```

- [ ] **Step 3: Run and watch them fail**

Run: `bun test apps/runner/src/workspace/collect.test.ts`
Expected: FAIL — `./collect.ts` missing.

- [ ] **Step 4: Implement `collect.ts`**

Try `spawn(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], root)`; on `exitCode === 0` split stdout on `"\0"`, drop empties. Otherwise walk: recursive `readdir` with `withFileTypes`, skipping `.git` and `["node_modules","dist","build",".venv","__pycache__","target"]`. For each candidate use `lstat`: credential basename → excluded `credential`; symbolic link → `symlink`; not a regular file → `non_regular`. Sort paths; cap at `maxEntries ?? MAX_SNAPSHOT_ENTRIES` and set `truncated`.

- [ ] **Step 5: Run and watch them pass**

Run: `bun test apps/runner` and `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A apps/runner/src/inspection apps/runner/src/workspace
git commit -m "feat(runner): collect workspace files for the run-start baseline"
```

---

## Task 5: Runner — capture the baseline into blobs + runner-db

**Files:**
- Create: `apps/runner/src/workspace/snapshot.ts`, `apps/runner/src/workspace/snapshot.test.ts`

**Interfaces:**
- Consumes: `collectWorkspaceFiles`, `recordSnapshot`, `pruneSnapshots`, `redactErrorText`.
- Produces:
  - `blobPath(homeDir: string, hash: string): string` → `<homeDir>/snapshots/blobs/<hash>`
  - `createBaselineCapture({ db, homeDir, spawn?, now?, limits? }): (workspacePath, attemptId, sessionId) => Promise<{ ok: true } | { ok: false; reason: string }>`
  - `limits?: { fileBytes?: number; totalBytes?: number; entries?: number }` — test seam only, production omits it.

- [ ] **Step 1: Write the failing tests**

```ts
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { migrateRunnerDb } from "@cc-web/runner-db";
import { createBaselineCapture } from "./snapshot.ts";

const dirs: string[] = [];
async function dir(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const sha = (s: string) => createHash("sha256").update(Buffer.from(s)).digest("hex");
const noGit = async () => ({ exitCode: 1, stdout: "" });

test("captures content into a content-addressed blob and a kept row", async () => {
  const db = new Database(":memory:"); migrateRunnerDb(db);
  const root = await dir("cc-web-snap-root-");
  const home = await dir("cc-web-snap-home-");
  await writeFile(join(root, "a.ts"), "export {};\n");
  const capture = createBaselineCapture({ db, homeDir: home, spawn: noGit });
  expect(await capture(root, "a-1", "s-1")).toEqual({ ok: true });
  expect(await readFile(join(home, "snapshots", "blobs", sha("export {};\n")), "utf8"))
    .toBe("export {};\n");
  const row = db.query("SELECT path, state, hash FROM file_snapshots WHERE attempt_id = 'a-1'").get() as
    { path: string; state: string; hash: string };
  expect(row).toEqual({ path: "a.ts", state: "kept", hash: sha("export {};\n") });
});

test("a file over the per-file cap is recorded excluded, not omitted", async () => {
  const db = new Database(":memory:"); migrateRunnerDb(db);
  const root = await dir("cc-web-snap-root-");
  const home = await dir("cc-web-snap-home-");
  await writeFile(join(root, "big.bin"), "0123456789");
  const capture = createBaselineCapture({
    db, homeDir: home, spawn: noGit, limits: { fileBytes: 4 },
  });
  expect(await capture(root, "a-1", "s-1")).toEqual({ ok: true });
  const row = db.query("SELECT state, reason FROM file_snapshots").get() as
    { state: string; reason: string };
  expect(row).toEqual({ state: "excluded", reason: "oversize" });
});

test("crossing the byte cap marks the run partial and leaves later files unbaselined", async () => {
  const db = new Database(":memory:"); migrateRunnerDb(db);
  const root = await dir("cc-web-snap-root-");
  const home = await dir("cc-web-snap-home-");
  await writeFile(join(root, "a.ts"), "1234");
  await writeFile(join(root, "b.ts"), "5678");
  const capture = createBaselineCapture({
    db, homeDir: home, spawn: noGit, limits: { totalBytes: 4 },
  });
  await capture(root, "a-1", "s-1");
  const run = db.query("SELECT partial FROM snapshot_runs WHERE attempt_id = 'a-1'").get() as
    { partial: number };
  expect(run.partial).toBe(1);
  const reasons = db.query("SELECT path, state, reason FROM file_snapshots ORDER BY path").all();
  expect(reasons).toEqual([
    { path: "a.ts", state: "kept", reason: null },
    { path: "b.ts", state: "excluded", reason: "unbaselined" },
  ]);
});

test("pruning keeps five baselines and deletes the unreferenced blob", async () => {
  const db = new Database(":memory:"); migrateRunnerDb(db);
  const root = await dir("cc-web-snap-root-");
  const home = await dir("cc-web-snap-home-");
  const capture = createBaselineCapture({ db, homeDir: home, spawn: noGit });
  for (let i = 0; i < 6; i++) {
    await writeFile(join(root, "a.ts"), `v${i}`);
    await capture(root, `a-${i}`, "s-1");
  }
  expect(existsSync(join(home, "snapshots", "blobs", sha("v0")))).toBe(false);
  expect(existsSync(join(home, "snapshots", "blobs", sha("v5")))).toBe(true);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test apps/runner/src/workspace/snapshot.test.ts`
Expected: FAIL — `./snapshot.ts` missing.

- [ ] **Step 3: Implement `snapshot.ts`**

Order: collect → sort → for each path: `lstat`, skip if gone; oversize → `excluded "oversize"`; byte cap reached → `partial = true` and this + all later → `excluded "unbaselined"`; else read, hash, write blob (`mkdir(join(home,"snapshots","blobs"), { recursive: true, mode: 0o700 })`, `writeFile(path, bytes, { mode: 0o600 })` only if absent), push `kept { path, hash, size, mode }`. Append collector exclusions. `recordSnapshot` with `capturedAt: now()`, `partial: partial || collected.truncated`. Then `pruneSnapshots(db, root, SNAPSHOT_RETENTION)` and `rm(blobPath(home, hash), { force: true })` per returned hash. Wrap everything in try/catch → `{ ok: false, reason: redactErrorText(...).slice(0, 200) }`.

- [ ] **Step 4: Run and watch them pass**

Run: `bun test apps/runner/src/workspace` and `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/workspace/snapshot.ts apps/runner/src/workspace/snapshot.test.ts
git commit -m "feat(runner): capture content-addressed run-start baselines"
```

---

## Task 6: Runner — capture seam in the executor

**Files:**
- Modify: `apps/runner/src/execution/executor.ts` (ExecuteOptions + the call site after `prepareWorkspace`)
- Modify: `apps/runner/src/execution/run-controller.ts` (pass-through option)
- Modify: `apps/runner/src/execution/executor.test.ts`, `apps/runner/src/execution/run-controller.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (a plain seam).
- Produces:
  - `ExecuteOptions.captureBaseline?: (workspacePath: string, attemptId: string, sessionId: string) => Promise<{ ok: true } | { ok: false; reason: string }>`
  - `RunControllerOptions.captureBaseline?: ExecuteOptions["captureBaseline"]`

- [ ] **Step 1: Write the failing tests**

In `executor.test.ts`:

```ts
test("captures the baseline after the branch gate and before the SDK", async () => {
  const order: string[] = [];
  const run = await executeRun(db, command({ attemptId: "a-1", sessionId: "s-1" }), {
    workspacePath: "/w",
    prepareWorkspace: async () => { order.push("prepare"); return { kind: "ready", checkedOut: false }; },
    captureBaseline: async (_path, attemptId) => { order.push(`capture:${attemptId}`); return { ok: true }; },
    sdk: () => (async function* () { order.push("sdk"); yield { type: "result", subtype: "success", result: "ok" }; })(),
  });
  expect(order).toEqual(["prepare", "capture:a-1", "sdk"]);
});

test("a refused branch gate never captures", async () => {
  const seen: string[] = [];
  await executeRun(db, command({ attemptId: "a-2" }), {
    workspacePath: "/w",
    prepareWorkspace: async () => ({ kind: "refused", reason: "dirty_tree" }),
    captureBaseline: async () => { seen.push("capture"); return { ok: true }; },
    sdk: () => (async function* () { yield { type: "result", subtype: "success", result: "ok" }; })(),
  });
  expect(seen).toEqual([]);
});

test("a failed capture fails the run with snapshot_failed", async () => {
  const outcome = await executeRun(db, command({ attemptId: "a-3" }), {
    workspacePath: "/w",
    captureBaseline: async () => ({ ok: false, reason: "disk full" }),
    sdk: () => (async function* () { throw new Error("must not start"); })(),
  });
  expect(outcome.state).toBe("failed");
  const types = db.query("SELECT type, payload FROM event_outbox WHERE attempt_id = 'a-3' ORDER BY local_sequence").all();
  expect(types).toContainEqual({
    type: "run.failed",
    payload: JSON.stringify({ error: "snapshot_failed", reason: "disk full" }),
  });
});
```

Use the file's existing helpers to build `db` and `command`; adapt names rather than inventing new ones.

In `run-controller.test.ts`:

```ts
test("a capture failure releases the workspace lock", async () => {
  // reuse the file's setup(): in-memory db, WORKSPACES map, fake SDK seam
  const controller = new RunController({
    db, localRunnerId: "runner-a", workspacePathFor: () => "/w",
    captureBaseline: async () => ({ ok: false, reason: "boom" }),
    sdk: () => (async function* () { yield { type: "result", subtype: "success", result: "ok" }; })(),
  });
  await controller.handle(runStartCommand({ attemptId: "a-1" }));
  await controller.settled("a-1");           // the file's existing await helper
  expect(db.query("SELECT COUNT(*) AS n FROM workspace_locks").get()).toEqual({ n: 0 });
  expect(db.query("SELECT state FROM local_attempts WHERE attempt_id = 'a-1'").get())
    .toEqual({ state: "failed" });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test apps/runner/src/execution/executor.test.ts apps/runner/src/execution/run-controller.test.ts`
Expected: FAIL — `captureBaseline` unknown in `ExecuteOptions` (typecheck) and never called.

- [ ] **Step 3: Implement**

Add the option to `ExecuteOptions` and pass it through `RunController` exactly like `prepareWorkspace` (constructor field + spread into `executeRun`). In `executor.ts`, immediately after the `prepareWorkspace` block and before `options.router`:

```ts
if (options.captureBaseline !== undefined) {
  const captured = await options.captureBaseline(options.workspacePath, attemptId, sessionId);
  if (!captured.ok) {
    state = "failed";
    terminalWritten = true;
    append("run.failed", { error: "snapshot_failed", reason: captured.reason });
    return { state: "failed" };
  }
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `bun test apps/runner/src/execution` and `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/execution/executor.ts apps/runner/src/execution/run-controller.ts apps/runner/src/execution/executor.test.ts apps/runner/src/execution/run-controller.test.ts
git commit -m "feat(runner): capture the run-start baseline inside the attempt"
```

---

## Task 7: Runner — save (`file.write`)

**Files:**
- Create: `apps/runner/src/mutation/handler.ts`, `apps/runner/src/mutation/handler.test.ts`

**Interfaces:**
- Consumes: `parseMutationRequest`, `lockHolder`, `WRITE_CAPABILITY`, `MAX_SNAPSHOT_FILE_BYTES`, `resolveInsideWorkspace`, `isRefusedCredentialBasename`, `redactErrorText`.
- Produces:
  - `MUTATION_CAPABILITIES: string[]` → `[WRITE_CAPABILITY]`
  - `createMutationHandler({ db, workspacePathFor, homeDir, now?, spawn? }): (command: unknown) => Promise<RpcResultFrame>`
  - Refusal codes used here: `WORKSPACE_BUSY`, `WORKSPACE_NOT_FOUND`, `UNSUPPORTED_COMMAND`, `PATH_OUTSIDE_WORKSPACE`, `CREDENTIAL_FILE_REFUSED`, `FILE_NOT_FOUND`, `SYMLINK_REFUSED`, `FILE_UNSUPPORTED`, `FILE_CONFLICT`, `FILE_UNWRITABLE`.

- [ ] **Step 1: Write the failing tests**

Test file setup (reused by Tasks 8–10):

```ts
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { migrateRunnerDb } from "@cc-web/runner-db";
import { createMutationHandler } from "./handler.ts";

const roots: string[] = [];
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cc-web-mutate-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });
const sha = (s: string) => createHash("sha256").update(Buffer.from(s)).digest("hex");

const noGit = async () => ({ exitCode: 1, stdout: "" });

function setup(root: string) {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  const handler = createMutationHandler({
    db, workspacePathFor: (id) => (id === "default" ? root : undefined),
    homeDir: root, spawn: noGit,
  });
  return { db, handler };
}

const write = (commandId: string, path: string, content: string, expectedHash: string) => ({
  protocolVersion: 1, commandId, runnerId: "runner-a", workspaceId: "default",
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
  expect((await readdir(root)).sort()).toEqual(["a.txt"]);   // no temp file left
});

test("a stale token is a conflict and changes nothing", async () => {
  const root = await workspace();
  await writeFile(join(root, "a.txt"), "prev\n");
  const { handler } = setup(root);
  const frame = await handler(write("c1", "a.txt", "next\n", "stale"));
  expect(frame).toEqual({
    type: "rpc.result", commandId: "c1", ok: false,
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
  const code = async (path: string) => (await handler(write("c", path, "x", "whatever"))).error?.code;
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
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test apps/runner/src/mutation/handler.test.ts`
Expected: FAIL — `./handler.ts` missing.

- [ ] **Step 3: Implement `handler.ts` (save only)**

Spine: read `commandId`, `kind`, `workspaceId`; `parseMutationRequest`; resolve root; `try { return await dispatch(...) } catch { refuse FILE_UNWRITABLE }`. `dispatch` switches on `request.op` (`file.write` now; other cases arrive in Tasks 8 and 10).

`writeFile`:
1. `lockHolder(db, root)` → `WORKSPACE_BUSY`.
2. `resolveInsideWorkspace(root, path)`; map its refusal codes straight through.
3. `lstat(absolutePath)` → `SYMLINK_REFUSED` when `isSymbolicLink()`, `FILE_UNSUPPORTED` when not a file, `FILE_NOT_FOUND` when missing.
4. Read bytes; binary sniff (`bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)`) or `size > MAX_SNAPSHOT_FILE_BYTES` → `FILE_UNSUPPORTED`; `sha256(bytes) !== expectedHash` → `FILE_CONFLICT`.
5. `Buffer.byteLength(content) > MAX_SNAPSHOT_FILE_BYTES` → `FILE_UNSUPPORTED`.
6. Atomic write:

```ts
async function writeAtomic(target: string, bytes: Buffer, mode: number): Promise<void> {
  const temp = join(dirname(target), `.cc-web-${randomUUID()}.tmp`);
  const handle = await open(temp, "w", mode);
  try {
    await handle.write(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temp, mode);
  await rename(temp, target);
}
```

7. Return `{ op: "file.write", path, hash: sha256(newBytes), size: newBytes.length }`. Use `const mode = info.mode & 0o777` from the `lstat`.

- [ ] **Step 4: Run and watch them pass**

Run: `bun test apps/runner/src/mutation` and `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/mutation/handler.ts apps/runner/src/mutation/handler.test.ts
git commit -m "feat(runner): revision-checked file save over the mutation lane"
```

---

## Task 8: Runner — per-file revert (`file.revert`)

**Files:**
- Modify: `apps/runner/src/mutation/handler.ts` (add the `file.revert` case)
- Modify: `apps/runner/src/mutation/handler.test.ts`

**Interfaces:**
- Consumes: `latestSnapshot`, `blobPath`, the save task's `resolveInsideWorkspace`/`readCurrent` helpers.
- Produces: the revert table from spec §7.6; refusal codes `NO_SNAPSHOT`, `FILE_CONFLICT`, `FILE_UNSUPPORTED`, `WORKSPACE_BUSY`.

- [ ] **Step 1: Write the failing tests** (test-local baseline seed)

```ts
async function seedBaseline(
  db: Database, root: string, attemptId: string, files: Record<string, string | null>,
) {
  const entries = [];
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      entries.push({ path, state: "excluded" as const, reason: "oversize" });
      continue;
    }
    const hash = sha(content);
    await Bun.write(join(root, "snapshots", "blobs", hash), content);
    entries.push({ path, state: "kept" as const, hash, size: Buffer.byteLength(content), mode: 0o644 });
  }
  recordSnapshot(db, {
    attemptId, workspacePath: root, collector: "walk", capturedAt: 1,
    partial: false, entries,
  });
}
```

The blob directory is `<homeDir>/snapshots/blobs`; here `homeDir` is the workspace root (see `setup`).

```ts
const revert = (commandId: string, path: string, expectedHash: string | null) => ({
  protocolVersion: 1, commandId, runnerId: "runner-a", workspaceId: "default",
  kind: "workspace.file.revert", payload: { op: "file.revert", path, expectedHash },
});

test("restores the baseline bytes when the current hash matches", async () => {
  const root = await workspace();
  await mkdir(join(root, "snapshots", "blobs"), { recursive: true });
  const { db, handler } = setup(root);
  await seedBaseline(db, root, "a-1", { "a.txt": "prev\n" });
  await writeFile(join(root, "a.txt"), "next\n");
  const frame = await handler(revert("c1", "a.txt", sha("next\n")));
  expect(frame.result).toEqual({
    op: "file.revert", path: "a.txt", action: "restored", hash: sha("prev\n"), size: 5,
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
    op: "file.revert", path: "created.txt", action: "deleted", hash: null, size: null,
  });
  await expect(readFile(join(root, "created.txt"), "utf8")).rejects.toThrow();
});

test("a path absent now and at run start is a no-op", async () => {
  const root = await workspace();
  const { db, handler } = setup(root);
  await seedBaseline(db, root, "a-1", { "a.txt": "prev\n" });
  expect((await handler(revert("c1", "gone.txt", null))).result).toEqual({
    op: "file.revert", path: "gone.txt", action: "none", hash: null, size: null,
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
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test apps/runner/src/mutation/handler.test.ts`
Expected: FAIL — the `file.revert` payload is refused as `UNSUPPORTED_COMMAND` (the dispatch case is missing).

- [ ] **Step 3: Implement the `file.revert` case**

`latestSnapshot(db, root)` → `NO_SNAPSHOT`; `lockHolder` → `WORKSPACE_BUSY`. Then the §7.6 table: read current (`absent` or `{ bytes, hash, mode }`; symlink/oversize/binary current → `FILE_UNSUPPORTED`); `expectedHash === null` asserts absence, otherwise must equal `sha256(current)` else `FILE_CONFLICT`; `entry` missing → delete the regular file (`rm(absolute)`, refuse if `lstat` says not a file); `entry.state === "excluded"` → `FILE_UNSUPPORTED` with the row's reason; `kept` → write the blob bytes atomically with the stored mode (`storedMode ?? 0o644`), recreating the file when absent. Return `hash`/`size` describing the file now.

- [ ] **Step 4: Run and watch them pass**

Run: `bun test apps/runner/src/mutation` and `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/mutation/handler.ts apps/runner/src/mutation/handler.test.ts
git commit -m "feat(runner): revert one file to its run-start baseline"
```

---

## Task 9: Runner — snapshot status (`snapshot.status`)

**Files:**
- Create: `apps/runner/src/workspace/status.ts`, `apps/runner/src/workspace/status.test.ts`
- Modify: `apps/runner/src/inspection/handler.ts` (op + optional seam)
- Modify: `apps/runner/src/inspection/handler.test.ts`

**Interfaces:**
- Consumes: `latestSnapshot`, `collectWorkspaceFiles`, `sha256`, `MAX_STATUS_ENTRIES`.
- Produces:
  - `type StatusOutcome = { ok: true; result: SnapshotStatusResult } | { ok: false; code: string }`
  - `computeSnapshotPlan({ db, spawn }, root): Promise<{ plan: SnapshotStatusResult } | { code: "NO_SNAPSHOT" | "SNAPSHOT_INCOMPARABLE" }>`
  - `createSnapshotStatus({ db, spawn?, maxEntries? }): (root: string) => Promise<StatusOutcome>`
  - `InspectHandlerOptions.snapshotStatus?: (root: string) => Promise<StatusOutcome>`; `snapshot.status` dispatch; missing seam → `UNSUPPORTED_COMMAND`.

- [ ] **Step 1: Write the failing status tests**

```ts
test("a workspace with no baseline answers baseline: null", async () => {
  const root = await workspace();
  const status = createSnapshotStatus({ db: freshDb(), spawn: noGit });
  expect(await status(root)).toEqual({
    ok: true,
    result: { op: "snapshot.status", baseline: null, entries: [], counts: { modified: 0, created: 0, deleted: 0, excluded: 0 }, digest: null, truncated: false },
  });
});

test("classifies modified, created and deleted against the baseline", async () => {
  // baseline: a.txt "prev\n", gone.txt "bye\n"; now: a.txt "next\n", created.txt "new\n"
  // expect entries sorted: a.txt modified, created.txt created, gone.txt deleted
  // counts: { modified: 1, created: 1, deleted: 1, excluded: 0 }
});

test("the digest is stable across identical trees and changes with the content", async () => {
  // compute twice with no change → same digest; edit a file → different digest
});

test("excluded entries keep their reason and are not revertable", async () => {
  // seed an entry with state "excluded", reason "oversize"; expect that entry with revertable false
});

test("a git baseline with no repository is incomparable", async () => {
  // seed collector "git"; spawn exits 1 → { ok: false, code: "SNAPSHOT_INCOMPARABLE" }
});
```

The concrete bodies follow the file's helpers (`freshDb()` = in-memory `migrateRunnerDb`; `workspace()`/`noGit` as in Task 5). Fill the first test's literal exactly as above; the other four assert the named fields.

In `inspection/handler.test.ts`:

```ts
test("snapshot.status is served through the injected seam", async () => {
  const handler = createInspectHandler({
    workspacePathFor: (id) => (id === "default" ? root : undefined),
    snapshotStatus: async () => ({
      ok: true,
      result: { op: "snapshot.status", baseline: null, entries: [], counts: { modified: 0, created: 0, deleted: 0, excluded: 0 }, digest: null, truncated: false },
    }),
  });
  const frame = await handler({ commandId: "c1", kind: "workspace.inspect", workspaceId: "default", payload: { op: "snapshot.status" } });
  expect(frame.ok).toBe(true);
});

test("without the seam snapshot.status is unsupported", async () => {
  const handler = createInspectHandler({ workspacePathFor: () => root });
  const frame = await handler({ commandId: "c1", kind: "workspace.inspect", workspaceId: "default", payload: { op: "snapshot.status" } });
  expect(frame.error?.code).toBe("UNSUPPORTED_COMMAND");
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test apps/runner/src/workspace/status.test.ts apps/runner/src/inspection/handler.test.ts`
Expected: FAIL — `./status.ts` missing; the inspect handler refuses `snapshot.status` as an unrecognised payload.

- [ ] **Step 3: Implement**

`status.ts`: plan computation per spec §7.7 — collector in the baseline's mode; entries built from manifest + collected-now; `excluded` carries its reason; current symlink/binary/oversize → `excluded` with reason; sort by path; cap `maxEntries ?? MAX_STATUS_ENTRIES` (set `truncated`); counts; digest = `sha256(`${attemptId}\n${lines.join("\n")}`)` over `` `${status}\t${path}\t${snapshotHash ?? ""}\t${currentHash ?? ""}` `` where lines are in sorted order, `null` when truncated. Mode reproduction: baseline `collector: "git"` and `collectWorkspaceFiles` returns `mode: "walk"` → `SNAPSHOT_INCOMPARABLE`.

`inspection/handler.ts`: add `snapshotStatus` to options; `case "snapshot.status":` in `dispatch` maps `ok:true` to `answer`, `ok:false` to `refuse(code, ...)`, missing seam to `UNSUPPORTED_COMMAND`.

- [ ] **Step 4: Run and watch them pass**

Run: `bun test apps/runner/src/workspace apps/runner/src/inspection` and `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/workspace/status.ts apps/runner/src/workspace/status.test.ts apps/runner/src/inspection/handler.ts apps/runner/src/inspection/handler.test.ts
git commit -m "feat(runner): report the workspace status against its run-start baseline"
```

---

## Task 10: Runner — whole-workspace revert (`workspace.revert`)

**Files:**
- Modify: `apps/runner/src/mutation/handler.ts` (add the `workspace.revert` case)
- Modify: `apps/runner/src/mutation/handler.test.ts`

**Interfaces:**
- Consumes: `computeSnapshotPlan`, `acquireWorkspaceLock`, `releaseAttempt`, `MAX_REVERT_FILES`, `MAX_REVERT_BYTES`.
- Produces: apply semantics from spec §7.8 — `REVERT_STALE`, `SNAPSHOT_PARTIAL`, `PLAN_TOO_LARGE`, `WORKSPACE_BUSY`, best-effort result.

- [ ] **Step 1: Write the failing tests**

```ts
const apply = (commandId: string, planDigest: string) => ({
  protocolVersion: 1, commandId, runnerId: "runner-a", workspaceId: "default",
  kind: "workspace.revert", payload: { op: "workspace.revert", planDigest },
});

async function planDigestFor(db: Database, root: string) {
  const computed = await computeSnapshotPlan({ db, spawn: noGit }, root);
  if ("code" in computed) throw new Error(computed.code);
  return computed.plan.digest!;
}

test("applies a matching plan: restores what changed, deletes what was created", async () => {
  // baseline a.txt "prev\n"; now a.txt "next\n" and created.txt "new\n"
  // digest = planDigestFor(...); apply → restored 1, deleted 1, failed null
  // a.txt back to "prev\n"; created.txt gone; workspace lock released
});

test("a stale plan applies nothing", async () => {
  // compute digest, then edit a.txt again; apply with the old digest
  // expect error REVERT_STALE and the newer content untouched
});

test("a partial baseline refuses the bulk revert", async () => {
  // seed snapshot_runs partial = 1 → SNAPSHOT_PARTIAL
});

test("a plan over the file budget refuses", async () => {
  // 301 created files → PLAN_TOO_LARGE (MAX_REVERT_FILES)
});

test("a held lock refuses the apply and names the holder", async () => {
  // insert workspace_locks row → WORKSPACE_BUSY
});

test("files the collector excludes are never deleted", async () => {
  // root has node_modules/x.js and .env besides baseline a.txt
  // plan counts created: 0 for them; apply leaves both files in place
});
```

Use the same `setup`/`seedBaseline` helpers, importing `computeSnapshotPlan` from `../workspace/status.ts` for the digest. The handler computes its plan through that same function with its own `db` and `spawn` — there is no second seam.

- [ ] **Step 2: Run and watch them fail**

Run: `bun test apps/runner/src/mutation/handler.test.ts`
Expected: FAIL — `workspace.revert` is refused as `UNSUPPORTED_COMMAND`.

- [ ] **Step 3: Implement**

`workspace.revert`:
1. `computeSnapshotPlan` → `NO_SNAPSHOT` / `SNAPSHOT_INCOMPARABLE` refusals; `plan.baseline.partial` → `SNAPSHOT_PARTIAL`; `truncated` or entries over `MAX_REVERT_FILES` / sum of sizes over `MAX_REVERT_BYTES` → `PLAN_TOO_LARGE`.
2. `plan.digest !== request.planDigest` → `REVERT_STALE`.
3. `acquireWorkspaceLock(db, root, `revert:${commandId}`)` false → `WORKSPACE_BUSY`; release in `finally` via `releaseAttempt(db, `revert:${commandId}`)`.
4. Recompute the plan once more under the lock; digest mismatch again → `REVERT_STALE`.
5. Apply in sorted order: `modified`/`deleted` (restore blob), `created` (delete regular file); `excluded` untouched. Re-verify each current hash immediately before acting; on failure return `{ restored, deleted, failed: { path, code } }`.
6. Success → `{ planDigest, restored, deleted, failed: null }`.

- [ ] **Step 4: Run and watch them pass**

Run: `bun test apps/runner/src/mutation` and `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/mutation/handler.ts apps/runner/src/mutation/handler.test.ts
git commit -m "feat(runner): apply a previewed whole-workspace revert"
```

---

## Task 11: Runner — daemon wiring and capabilities

**Files:**
- Modify: `apps/runner/src/daemon.ts` (dispatch, handlers, hello capabilities, capture wiring)
- Modify: `apps/runner/src/daemon.test.ts`

**Interfaces:**
- Consumes: `createMutationHandler`, `MUTATION_CAPABILITIES`, `createSnapshotStatus`, `createBaselineCapture`.
- Produces: hello capabilities `["inspect", "workspace.write"]`; three-way dispatch; the executor capture wired to runner-db.

- [ ] **Step 1: Write the failing tests** in `daemon.test.ts`

```ts
test("hello advertises both the inspect and write capabilities", () => {
  const hello = helloFrame({ runnerId: "r", runnerVersion: "0", sdkVersion: "0", bootId: "b" });
  expect(hello.capabilities).toEqual(["inspect", "workspace.write"]);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test apps/runner/src/daemon.test.ts`
Expected: FAIL — capabilities are `["inspect"]`.

- [ ] **Step 3: Implement**

- `daemon.ts`: `const MUTATION_KINDS = new Set(["workspace.file.write", "workspace.file.revert", "workspace.revert"]);` + `isMutationKind` mirroring `isInspectKind`.
- Build `const snapshotDb = db;` handlers: `const mutate = options.mutation ?? createMutationHandler({ db, workspacePathFor: options.workspacePathFor ?? (() => undefined), homeDir: options.identityDir, spawn: gitSpawn });` and `const inspect = options.inspect ?? createInspectHandler({ workspacePathFor: ..., snapshotStatus: createSnapshotStatus({ db, spawn: gitSpawn }) });` (extend `DaemonOptions` with optional `mutation`/`snapshotStatus` overrides the way `inspect` is overridable).
- `dispatch`: inspect branch → existing; mutation branch → `mutate(command).then((frame) => ({ receipt: null, results: [frame] }))`; everything else → `runs.handle`.
- `RunController` gains `captureBaseline: options.captureBaseline ?? createBaselineCapture({ db, homeDir: options.identityDir, spawn: gitSpawn })` — add `captureBaseline?: ExecuteOptions["captureBaseline"]` to `DaemonOptions`.
- `helloFrame`: `capabilities: RUNNER_CAPABILITIES` where `const RUNNER_CAPABILITIES = [...INSPECT_CAPABILITIES, ...MUTATION_CAPABILITIES]`.

- [ ] **Step 4: Run and watch it pass**

Run: `bun test apps/runner` and `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/daemon.ts apps/runner/src/daemon.test.ts
git commit -m "feat(runner): route the mutation lane and capture baselines at run start"
```

---

## Task 12: Control server — shared RPC spine, four routes

**Files:**
- Create: `apps/control-server/src/routes/api-error.ts` (`jsonError`, `statusForCode`, `RETRYABLE_CODES` moved out of inspect-routes)
- Create: `apps/control-server/src/routes/rpc-command.ts` (`submitRpc`)
- Create: `apps/control-server/src/routes/mutation-routes.ts`
- Create: `apps/control-server/src/routes/mutation-routes.test.ts`
- Modify: `apps/control-server/src/routes/inspect-routes.ts` (use the shared modules; add `snapshot.status` op)
- Modify: `apps/control-server/src/server.ts` (four routes)
- Test: existing `inspect-routes.test.ts` must stay green unchanged

**Interfaces:**
- Consumes: `parseCompositeId`, `workspacesForOwner`, `PendingRpcRequests`, `Dispatcher`, `WRITE_CAPABILITY`, `INSPECT_CAPABILITY`.
- Produces:
  - `submitRpc(options, runnerGateway, pending, dispatcher, { runnerId, workspaceId, kind, payload, capability }): Promise<Response>`
  - `handleFileWrite(request, options, allowedOrigins, browserGateway, runnerGateway, pending, dispatcher, compositeId): Promise<Response>`
  - `handleFileRevert(...)` and `handleWorkspaceRevert(...)` with the same parameter list
  - `handleInspect(..., "snapshot.status")` served from `GET /api/workspaces/:id/snapshot`
  - `statusForCode` additions: `FILE_CONFLICT|WORKSPACE_BUSY|REVERT_STALE|SNAPSHOT_PARTIAL|PLAN_TOO_LARGE|SNAPSHOT_INCOMPARABLE` → 409; `NO_SNAPSHOT` → 404; `SYMLINK_REFUSED|FILE_UNSUPPORTED` → 400; `FILE_UNWRITABLE` → 502.

- [ ] **Step 1: Write the failing tests** in `mutation-routes.test.ts`

Copy the fixture functions `start()`, `connectInspectRunner()`, `runnerInbox()`, `waitFor` from `inspect-routes.test.ts` (rename the fixture `connectRunner`, keep `capabilities` defaulting to `["inspect", "workspace.write"]`). Tests:

```ts
test("PUT file saves through the runner and returns the new hash", async () => {
  // start + workspace + runner answering answer: fileWriteFrame(commandId)
  const response = await fetch(`${url}/api/workspaces/${composite}/file?path=a.txt`, {
    method: "PUT",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ content: "next\n", expectedHash: "prev" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ op: "file.write", path: "a.txt", hash: "new", size: 5 });
  expect(received[0]).toMatchObject({
    kind: "workspace.file.write",
    workspaceId: "default",
    payload: { op: "file.write", path: "a.txt", content: "next\n", expectedHash: "prev" },
  });
});

test("a stale token maps FILE_CONFLICT to 409 and is not retryable", async () => {
  // runner answers ok:false code FILE_CONFLICT
  // expect status 409 and body.error = { code: "FILE_CONFLICT", message: expect.any(String), retryable: false }
});

test("a runner without workspace.write is refused before enqueue", async () => {
  // connectRunner({ capabilities: ["inspect"] })
  // PUT → 503, body.error.code === "RUNNER_UNAVAILABLE", received.length === 0
});

test("a malformed body is a 400 and a >2 MiB body a 413", async () => {
  // PUT with {} → 400; PUT with content = "x".repeat(2 * 1024 * 1024 + 1) → 413
});

test("POST file/revert carries path and expectedHash", async () => {
  // body { path: "a.txt", expectedHash: null } → payload { op: "file.revert", path: "a.txt", expectedHash: null }
});

test("POST revert maps REVERT_STALE to 409", async () => {
  // body { planDigest: "d1" } → payload { op: "workspace.revert", planDigest: "d1" }; refusal maps 409
});

test("GET snapshot answers the baseline status without a body", async () => {
  // runner answers snapshot status with baseline null → 200 and no-store
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test apps/control-server/src/routes/mutation-routes.test.ts`
Expected: FAIL — `./mutation-routes.ts` missing.

- [ ] **Step 3: Implement**

`api-error.ts`: move `jsonError`, `statusForCode`, `RETRYABLE_CODES` verbatim from `inspect-routes.ts`, extend `statusForCode` with the codes above; import them back into `inspect-routes.ts`.

`rpc-command.ts`: extract the block from `handleInspect` that starts at the readiness check and ends with the 200 — signature above; it reads `input.capability` for the gate and `input.kind`/`payload` for the enqueue; everything else unchanged.

`inspect-routes.ts`: after ownership, build payload for `snapshot.status` (`{ op: "snapshot.status" }`) and call `submitRpc(..., capability: INSPECT_CAPABILITY)`.

`mutation-routes.ts`: each handler does origin → auth → `parseCompositeId` → `workspacesForOwner` → body (`request.text()`, length check 2 MiB → 413, `JSON.parse` object → 400) → build payload with manual `typeof` checks → `submitRpc(..., capability: WRITE_CAPABILITY)`.

`server.ts` routes (place beside the inspect routes, capture stays encoded):

```ts
const snapshotMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/snapshot$/);
if (snapshotMatch && request.method === "GET") { /* handleInspect(..., "snapshot.status") */ }

const writeMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/file$/);
if (writeMatch && request.method === "PUT") { /* handleFileWrite */ }

const fileRevertMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/file\/revert$/);
if (fileRevertMatch && request.method === "POST") { /* handleFileRevert */ }

const revertMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/revert$/);
if (revertMatch && request.method === "POST") { /* handleWorkspaceRevert */ }
```

- [ ] **Step 4: Run and watch them pass**

Run: `bun test apps/control-server` and `bun run typecheck`
Expected: PASS, including the untouched `inspect-routes.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/control-server/src/routes/api-error.ts apps/control-server/src/routes/rpc-command.ts apps/control-server/src/routes/mutation-routes.ts apps/control-server/src/routes/mutation-routes.test.ts apps/control-server/src/routes/inspect-routes.ts apps/control-server/src/server.ts
git commit -m "feat(server): serve save, revert and snapshot status over HTTP"
```

---

## Task 13: Web — mutation calls in `inspect-api.ts`

**Files:**
- Modify: `apps/web/src/services/inspect-api.ts`
- Modify: `apps/web/src/services/inspect-api.test.ts`

**Interfaces:**
- Consumes: `FileWriteResult`, `FileRevertResult`, `WorkspaceRevertResult`, `SnapshotStatusResult`.
- Produces:
  - `writeFile(id, path, content, expectedHash): Promise<InspectOutcome<FileWriteResult>>`
  - `revertFile(id, path, expectedHash: string | null): Promise<InspectOutcome<FileRevertResult>>`
  - `revertWorkspace(id, planDigest): Promise<InspectOutcome<WorkspaceRevertResult>>`
  - `fetchSnapshotStatus(id): Promise<InspectOutcome<SnapshotStatusResult>>`
  - MESSAGES additions: `FILE_CONFLICT`, `WORKSPACE_BUSY`, `SYMLINK_REFUSED`, `FILE_UNSUPPORTED`, `NO_SNAPSHOT`, `SNAPSHOT_PARTIAL`, `REVERT_STALE`, `PLAN_TOO_LARGE`, `SNAPSHOT_INCOMPARABLE`, `FILE_UNWRITABLE`.

- [ ] **Step 1: Write the failing tests** (extend the existing file; the `capture` helper already records url/method — add `body`/headers capture)

```ts
test("saves with PUT, a JSON body and the path in the query", async () => {
  const captured = capture(200, { op: "file.write", path: "a.txt", hash: "h2", size: 5 });
  const outcome = await writeFile("r-1%2Fdefault", "src/a.ts", "next\n", "h1");
  expect(outcome).toEqual({ ok: true, value: { op: "file.write", path: "a.txt", hash: "h2", size: 5 } });
  expect(captured.url).toBe("/api/workspaces/r-1%2Fdefault/file?path=src%2Fa.ts");
  expect(captured.method).toBe("PUT");
  expect(JSON.parse(captured.body)).toEqual({ content: "next\n", expectedHash: "h1" });
  expect(captured.contentType).toBe("application/json");
});

test("reverts one file with POST and an explicit null token", async () => {
  const captured = capture(200, { op: "file.revert", path: "new.ts", action: "deleted", hash: null, size: null });
  await revertFile("r-1%2Fdefault", "new.ts", null);
  expect(captured.url).toBe("/api/workspaces/r-1%2Fdefault/file/revert");
  expect(captured.method).toBe("POST");
  expect(JSON.parse(captured.body)).toEqual({ path: "new.ts", expectedHash: null });
});

test("applies a workspace revert with the plan digest", async () => {
  const captured = capture(200, { op: "workspace.revert", planDigest: "d1", restored: 1, deleted: 0, failed: null });
  await revertWorkspace("r-1%2Fdefault", "d1");
  expect(captured.url).toBe("/api/workspaces/r-1%2Fdefault/revert");
  expect(JSON.parse(captured.body)).toEqual({ planDigest: "d1" });
});

test("fetches the snapshot status", async () => {
  const captured = capture(200, { op: "snapshot.status", baseline: null, entries: [], counts: { modified: 0, created: 0, deleted: 0, excluded: 0 }, digest: null, truncated: false });
  await fetchSnapshotStatus("r-1%2Fdefault");
  expect(captured.url).toBe("/api/workspaces/r-1%2Fdefault/snapshot");
});

test("maps REVERT_STALE to Vietnamese copy", async () => {
  capture(409, { error: { code: "REVERT_STALE", message: "stale", retryable: false }, requestId: "r" });
  const outcome = await revertWorkspace("r-1%2Fdefault", "d1");
  expect(outcome).toEqual({ ok: false, code: "REVERT_STALE", message: "Kế hoạch khôi phục đã cũ — hãy xem lại." });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test apps/web/src/services/inspect-api.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

Generalise `request` into `request<T>(url, init?: RequestInit)`; add `mutate<T>(url, method: "PUT" | "POST", body: unknown)` that sets `Content-Type: application/json` and `JSON.stringify(body)`. All four calls use them. Add the MESSAGES entries with the Vietnamese copy above.

- [ ] **Step 4: Run and watch them pass**

Run: `bun test apps/web/src` and `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/inspect-api.ts apps/web/src/services/inspect-api.test.ts
git commit -m "feat(web): call save, revert and snapshot status from one service"
```

---

## Task 14: Web — pure edit/revert helpers

**Files:**
- Create: `apps/web/src/features/inspect/edit.ts`, `edit.test.ts`
- Create: `apps/web/src/features/inspect/revert.ts`, `revert.test.ts`

**Interfaces:**
- Consumes: `FileReadResult`, `FileWriteResult`, `SnapshotStatusResult`, `MAX_REVERT_FILES`.
- Produces:
  - `isDirty(original: string, draft: string): boolean`
  - `viewerAfterSave(viewer: FileReadResult, draft: string, written: FileWriteResult): FileReadResult`
  - `summarisePlan(status: SnapshotStatusResult): { restores: number; deletions: number; conflicts: number }`
  - `canApplyPlan(status: SnapshotStatusResult): { ok: true } | { ok: false; reason: string }`

- [ ] **Step 1: Write the failing tests**

```ts
test("dirty only when the draft differs", () => {
  expect(isDirty("a\n", "a\n")).toBe(false);
  expect(isDirty("a\n", "a")).toBe(true);
});

test("a save hands the next save its token", () => {
  const viewer = { op: "file.read", path: "a.ts", content: "old", binary: false, truncated: false, hash: "h1", size: 3 } as const;
  expect(viewerAfterSave(viewer, "new", { op: "file.write", path: "a.ts", hash: "h2", size: 3 }))
    .toEqual({ op: "file.read", path: "a.ts", content: "new", binary: false, truncated: false, hash: "h2", size: 3 });
});

test("summarises a plan into restores, deletions and conflicts", () => {
  const status = statusOf({ modified: 1, created: 2, deleted: 3, excluded: 4 });
  expect(summarisePlan(status)).toEqual({ restores: 4, deletions: 2, conflicts: 4 });
});

test("apply is refused with a reason for every unsafe baseline", () => {
  expect(canApplyPlan(statusOf())).toEqual({ ok: true });
  expect(canApplyPlan({ ...statusOf(), baseline: null }).ok).toBe(false);
  expect(canApplyPlan({ ...statusOf(), baseline: baseline({ partial: true }) }).ok).toBe(false);
  expect(canApplyPlan({ ...statusOf(), truncated: true }).ok).toBe(false);
  expect(canApplyPlan(statusOf({ modified: 301 })).ok).toBe(false);
});
```

Write the small `statusOf`/`baseline` helpers in the test file; `statusOf` defaults counts to zero and `digest: "d1"`.

- [ ] **Step 2: Run and watch them fail**

Run: `bun test apps/web/src/features/inspect`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement** the four functions; `canApplyPlan` checks, in order: `baseline === null` → "Chưa có bản chụp lúc bắt đầu chạy."; `baseline.partial` → "Bản chụp không đầy đủ."; `truncated` → "Danh sách thay đổi quá dài."; `digest === null` → "Không có kế hoạch để áp dụng."; `restores + deletions === 0` → "Không có gì để khôi phục."; `restores + deletions > MAX_REVERT_FILES` → "Phạm vi quá lớn — hãy khôi phục từng phần."

- [ ] **Step 4: Run and watch them pass**

Run: `bun test apps/web/src/features/inspect` and `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/inspect/edit.ts apps/web/src/features/inspect/edit.test.ts apps/web/src/features/inspect/revert.ts apps/web/src/features/inspect/revert.test.ts
git commit -m "feat(web): give the editor and the revert panel their pure logic"
```

---

## Task 15: Web — panel controls

**Files:**
- Modify: `apps/web/src/components/InspectPanel.vue`
- Verify: `apps/web/src/views/SessionView.vue` (no layout change expected)

**Interfaces:**
- Consumes: everything from Tasks 13–14.
- Produces: editable Files tab, conflict/busy banners, `Git (HEAD)` / `Từ lúc bắt đầu chạy` source switch, per-file revert with inline confirm, workspace-revert confirmation panel.

- [ ] **Step 1: Implement the Files tab editor**

State: `draft = ref<string | null>(null)`, `saving`, `saveError`, `confirmingClose`. When `openEntry` succeeds on a text, untruncated file, set `draft` from `content`; render `<textarea v-model="draft">` in place of `<pre>`. Save button: disabled unless `isDirty(viewer.content ?? "", draft)`; calls `writeFile(id, viewer.path, draft, viewer.hash)`; on success `viewer = viewerAfterSave(viewer, draft, value)`; on failure show `saveError` (conflict copy stays visible until "tải lại" re-runs `openEntry`). Keep the epoch guard: the save belongs to the same epoch check.

- [ ] **Step 2: Implement the snapshot source in the Changes tab**

Add `source = ref<"git" | "snapshot">("snapshot")`; a two-button switch in the header. Snapshot source loads `fetchSnapshotStatus(id)` into `snapshotStatus`; renders `baseline === null` as "Chưa có bản chụp lúc bắt đầu chạy."; otherwise `summarisePlan` counts, a per-row `khôi phục` button behind an inline confirm calling `revertFile(id, entry.path, entry.currentHash)`, and a header button `Khôi phục cả workspace` opening a panel with the counts, the first 50 paths of each class, and a confirm that calls `revertWorkspace(id, status.digest)`. `canApplyPlan` gates the confirm button and shows its reason. After a successful revert/save, re-run `loadChanges()`/the snapshot loader; do not touch the sessions store.

- [ ] **Step 3: Verify**

Run: `cd apps/web && bun run build`
Expected: build succeeds.
Run: `bun run typecheck` and `bun run lint`
Expected: clean (no shadcn files touched).
Manual check with the demo stack: open a session, edit a file, save; force a conflict by editing the file outside the browser and saving; revert one file; open the workspace revert panel, confirm counts, apply; verify a running agent blocks save with the busy copy.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/InspectPanel.vue
git commit -m "feat(web): edit, revert and preview the baseline beside the conversation"
```

---

## Task 16: End of branch — gates, review, push, ledger

**Files:**
- Modify: `TODO.md` (owner's checklist; do not commit)
- Modify: `.superpowers/sdd/2026-10-27-p3b-writes-revert-snapshots/progress.md` (gitignored ledger)

- [ ] **Step 1: Full gates** — `bun test`, `bun run typecheck`, `bun run lint`, `bun run test:integration`, `cd apps/web && bun run build`; every one green, output recorded in the ledger.
- [ ] **Step 2: Whole-branch review** — five lenses over the branch diff, adversarial verification of findings, fix pass with a test per accepted finding.
- [ ] **Step 3: Push `main`** and confirm `HEAD` equals `origin/main`.
- [ ] **Step 4: Update the ledger and `TODO.md`**, and update the handoff memory (`cc-web-handoff.md`) to point at P3-C.

---

## Self-Review Notes (for the author, not the executor)

- Spec §7.1–§7.12 each map to a task; §7.9 (locks) is pinned by Tasks 3, 7, 8, 10; §7.12 (compatibility) by Tasks 9 and 11.
- The `workspace.changed` non-goal and the Idempotency-Key non-goal carry no task by design (spec §3/§6.2 call 8).
- Names used consistently: `captureBaseline`, `snapshot.status`, `computeSnapshotPlan`, `createSnapshotStatus`, `acquireWorkspaceLock`, `recordSnapshot`, `latestSnapshot`, `pruneSnapshots`, `collectWorkspaceFiles`, `blobPath`, `viewerAfterSave`, `canApplyPlan`.
- `FILE_UNWRITABLE` is the one error code the plan adds beyond the spec's table; it is the mutation counterpart of `FILE_UNREADABLE` and maps to 502.
