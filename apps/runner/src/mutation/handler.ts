/**
 * Bounded workspace mutations (§7.1 write/revert lane).
 *
 * This module owns the `workspace.file.write`, `workspace.file.revert` and
 * `workspace.revert` command kinds. A write is revision-checked: the caller's
 * `expectedHash` must match the file on disk before the new bytes land.
 *
 * Refusals, never throws (mirroring the inspection handler idiom):
 * the frame is the only channel back to the server, so every failure becomes
 * `{ ok: false, error: { code, message } }` with a redacted message.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BINARY_SNIFF_BYTES,
  MAX_REVERT_BYTES,
  MAX_REVERT_FILES,
  MAX_SNAPSHOT_FILE_BYTES,
  type MutationRequest,
  type MutationResult,
  parseMutationRequest,
  type RpcResultFrame,
  type WorkspaceRevertResult,
  WRITE_CAPABILITY,
} from "@cc-web/protocol";
import { acquireWorkspaceLock, latestSnapshot, lockHolder, releaseAttempt } from "@cc-web/runner-db";
import { type GitSpawn } from "../git/spawn.ts";
import type { SnapshotStatusResult } from "../workspace/status.ts";
import { computeSnapshotPlan } from "../workspace/status.ts";
import { redactErrorText } from "../execution/redact.ts";
import { isNeverCollectedPath } from "../workspace/collect.ts";
import { resolveInsideWorkspace } from "../workspace/paths.ts";
import { blobPath } from "../workspace/snapshot.ts";

export type MutationHandlerOptions = {
  db: import("bun:sqlite").Database;
  /** Same seam the inspection handler uses. */
  workspacePathFor: (workspaceId: string) => string | undefined;
  spawn?: (args: string[], cwd: string) => Promise<{ exitCode: number; stdout: string }>;
  now?: () => number;
  homeDir?: string;
};

/** Advisory: which optional command kinds this runner implements. */
export const MUTATION_CAPABILITIES: string[] = [WRITE_CAPABILITY];

export function createMutationHandler(
  options: MutationHandlerOptions,
): (command: unknown) => Promise<RpcResultFrame> {
  const db = options.db;
  const workspacePathFor = options.workspacePathFor;
  const homeDir = options.homeDir;
  // spawn is accepted so later tasks (revert/commit) in this same file can use it;
  // it is unused for save and stored rather than deleted to avoid a dangling linter.
  const _spawn = options.spawn;
  void _spawn;

  function refuse(commandId: string, code: string, message: string): RpcResultFrame {
    return { type: "rpc.result", commandId, ok: false, error: { code, message } };
  }

  return async function handle(command: unknown): Promise<RpcResultFrame> {
    const record =
      typeof command === "object" && command !== null
        ? (command as Record<string, unknown>)
        : undefined;
    const commandId = typeof record?.["commandId"] === "string" ? record["commandId"] : "";

    if (record === undefined)
      return refuse(commandId, "UNSUPPORTED_COMMAND", "command must be an object");

    const kind = record["kind"];
    if (typeof kind !== "string")
      return refuse(commandId, "UNSUPPORTED_COMMAND", "command has no kind");

    const request = parseMutationRequest(kind, record["payload"]);
    if (request === undefined)
      return refuse(commandId, "UNSUPPORTED_COMMAND", "unrecognised mutation payload");

    const workspaceId = record["workspaceId"];
    if (typeof workspaceId !== "string" || workspaceId === "")
      return refuse(commandId, "WORKSPACE_NOT_FOUND", "command names no workspace");
    const root = workspacePathFor(workspaceId);
    if (root === undefined)
      return refuse(commandId, "WORKSPACE_NOT_FOUND", "workspace is not served by this runner");

    try {
      return await dispatch(commandId, root, homeDir ?? root, request, db);
    } catch (error) {
      const message = redactErrorText(error instanceof Error ? error.message : String(error));
      return refuse(commandId, "FILE_UNWRITABLE", message.slice(0, 500));
    }
  };

  async function dispatch(
    commandId: string,
    root: string,
    homeDir: string,
    request: MutationRequest,
    db: import("bun:sqlite").Database,
  ): Promise<RpcResultFrame> {
    switch (request.op) {
      case "file.write":
        return fileWrite(commandId, root, db, request);
      case "file.revert":
        return fileRevert(commandId, root, homeDir, db, request);
      case "workspace.revert":
        return workspaceRevert(commandId, root, homeDir ?? root, db, request, _spawn as GitSpawn | undefined);
    }
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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

/**
 * Read the file at `absolutePath` (lstat'd, never dereferenced), returning its
 * bytes, sha256, and mode. Used by both `fileWrite` and `fileRevert` so the
 * symlink/binary/size/hash logic lives in one place.
 */
type CurrentFile =
  | { kind: "absent" }
  | { kind: "present"; bytes: Buffer; hash: string; mode: number }
  | { kind: "refused"; code: string; reason: string };

async function readCurrent(absolutePath: string): Promise<CurrentFile> {
  let info: Stats;
  try {
    info = await lstat(absolutePath);
  } catch {
    return { kind: "absent" };
  }

  if (info.isSymbolicLink())
    return { kind: "refused", code: "SYMLINK_REFUSED", reason: "symlinks are not mutable" };
  if (!info.isFile())
    return { kind: "refused", code: "FILE_UNSUPPORTED", reason: "path is not a regular file" };

  let bytes: Buffer;
  try {
    bytes = await readFile(absolutePath);
  } catch {
    return {
      kind: "refused",
      code: "FILE_UNREADABLE",
      reason: "current content could not be read",
    };
  }

  // Binary sniff and size cap apply to the on-disk file.
  const sniff = bytes.subarray(0, BINARY_SNIFF_BYTES);
  if (sniff.includes(0))
    return { kind: "refused", code: "FILE_UNSUPPORTED", reason: "binary file is not mutable" };
  if (bytes.byteLength > MAX_SNAPSHOT_FILE_BYTES)
    return { kind: "refused", code: "FILE_UNSUPPORTED", reason: "file is too large to mutate" };

  return { kind: "present", bytes, hash: sha256(bytes), mode: info.mode & 0o777 };
}

/**
 * `workspace.file.write`: a revision-checked save of one file's contents.
 */
async function fileWrite(
  commandId: string,
  root: string,
  db: import("bun:sqlite").Database,
  request: { op: "file.write"; path: string; content: string; expectedHash: string },
): Promise<RpcResultFrame> {
  function refuse(code: string, message: string): RpcResultFrame {
    return { type: "rpc.result", commandId, ok: false, error: { code, message } };
  }

  // 1. Workspace lock check.
  const holder = lockHolder(db, root);
  if (holder !== undefined)
    return refuse("WORKSPACE_BUSY", "workspace is currently locked by a run");

  // 2. Resolve the target inside the workspace. No allowMissing: a save must name
  //    an existing file. resolveInsideWorkspace maps its own refusal codes, which
  //    this op forwards straight through.
  const candidate = join(root, request.path);
  const resolved = await resolveInsideWorkspace(root, request.path);
  if (!resolved.ok) return refuse(resolved.code, "path is not writable");

  // 3. lstat the candidate path as named by the caller, so a symlink is refused
  //    as SYMLINK_REFUSED even if it points at a regular file, and a non-file
  //    target is refused as FILE_UNSUPPORTED.
  const current = await readCurrent(candidate);
  if (current.kind === "absent") return refuse("FILE_NOT_FOUND", "path does not exist");
  if (current.kind === "refused") return refuse(current.code, current.reason);

  // 4b. Revision check: the caller's token must match what is on disk today.
  if (current.hash !== request.expectedHash)
    return refuse("FILE_CONFLICT", "expected hash does not match current content");

  // 5. New content size cap (checked before any write).
  const newBytes = Buffer.from(request.content, "utf8");
  if (newBytes.byteLength > MAX_SNAPSHOT_FILE_BYTES)
    return refuse("FILE_UNSUPPORTED", "new content exceeds the file size cap");

  // 6. Atomic write, preserving the file's existing permission bits.
  try {
    await writeAtomic(resolved.absolutePath, newBytes, current.mode);
  } catch (error) {
    return refuse(
      "FILE_UNWRITABLE",
      redactErrorText(error instanceof Error ? error.message : String(error)).slice(0, 500),
    );
  }

  // 7. Return the new token so the caller can chain edits.
  const newHash = sha256(newBytes);
  const result: MutationResult = {
    op: "file.write",
    path: request.path,
    hash: newHash,
    size: newBytes.length,
  };
  return { type: "rpc.result", commandId, ok: true, result };
}

/**
 * `workspace.file.revert`: restore one file to its run-start baseline.
 *
 * §7.6 revert table: current absent + entry kept -> restore the blob bytes with
 * the entry's stored mode (recreating the file); current absent + no entry ->
 * no-op; current present + no entry -> delete the regular file; current present
 * + excluded entry -> FILE_UNSUPPORTED (carry the row's reason); hash mismatch
 * with `expectedHash` -> FILE_CONFLICT and touch nothing.
 */
async function fileRevert(
  commandId: string,
  root: string,
  homeDir: string,
  db: import("bun:sqlite").Database,
  request: { op: "file.revert"; path: string; expectedHash: string | null },
): Promise<RpcResultFrame> {
  function refuse(code: string, message: string): RpcResultFrame {
    return { type: "rpc.result", commandId, ok: false, error: { code, message } };
  }

  // 1. Snapshot check: nothing to revert to (checked first per the brief's
  //    stated order: latestSnapshot -> NO_SNAPSHOT, then lockHolder -> WORKSPACE_BUSY).
  const snapshot = latestSnapshot(db, root);
  if (snapshot === undefined)
    return refuse("NO_SNAPSHOT", "no baseline snapshot is available for revert");

  // 2. Workspace lock check.
  const holder = lockHolder(db, root);
  if (holder !== undefined)
    return refuse("WORKSPACE_BUSY", "workspace is currently locked by a run");

  // 3. Resolve the target inside the workspace. allowMissing: revert legitimately
  //    names a path that is no longer on disk — an absent file is exactly the
  //    state a delete-revert starts from.
  const candidate = join(root, request.path);
  const resolved = await resolveInsideWorkspace(root, request.path, {}, { allowMissing: true });
  if (!resolved.ok) return refuse(resolved.code, "path is not revertable");

  // 4. Find the baseline entry for this path (sorted by path).
  const entry = snapshot.entries.find((e) => e.path === request.path);

  // 5. Read the current file state (lstat the candidate, never the realpath).
  const current = await readCurrent(candidate);
  if (current.kind === "refused") return refuse(current.code, current.reason);

  // 6. expectedHash revision check. When non-null it must match the current hash;
  //    when null it asserts the file is absent — present + null expectedHash is a
  //    conflict (§7.6 kept+present requires sha256(current) === expectedHash, and
  //    null can never satisfy it).
  if (request.expectedHash !== null) {
    if (current.kind === "absent") {
      return refuse("FILE_CONFLICT", "expected hash does not match current content");
    }
    if (current.hash !== request.expectedHash) {
      return refuse("FILE_CONFLICT", "expected hash does not match current content");
    }
  } else if (current.kind === "present") {
    // null expectedHash asserts absence, but the file is present.
    return refuse("FILE_CONFLICT", "expected hash does not match current content");
  }

  // 7. Revert table.
  if (current.kind === "absent") {
    // Current absent.
    if (entry === undefined) {
      // absent now + no entry: refuse never-collected paths before the no-op, so a
      // raw revert can never delete e.g. .git/config (the manifest never has an
      // entry for it, but "absent + no entry" must not silently succeed).
      if (isNeverCollectedPath(request.path))
        return refuse("FILE_UNSUPPORTED", "path is not part of the collectable workspace");
      // absent now + no entry -> no-op.
      return {
        type: "rpc.result",
        commandId,
        ok: true,
        result: { op: "file.revert", path: request.path, action: "none", hash: null, size: null },
      };
    }
    if (entry.state === "excluded") {
      // absent now + excluded entry -> FILE_UNSUPPORTED with the row's reason.
      return refuse("FILE_UNSUPPORTED", entry.reason ?? "file was excluded from baseline");
    }
    // absent now + kept entry -> restore the blob bytes with the entry's stored mode.
    const blob = blobPath(homeDir, entry.hash!);
    let bytes: Buffer;
    try {
      bytes = await readFile(blob);
    } catch {
      return refuse("FILE_UNWRITABLE", "baseline blob could not be read");
    }
    const mode = entry.mode ?? 0o644;
    await writeAtomic(resolved.absolutePath, bytes, mode);
    const hash = sha256(bytes);
    return {
      type: "rpc.result",
      commandId,
      ok: true,
      result: {
        op: "file.revert",
        path: request.path,
        action: "restored",
        hash,
        size: bytes.length,
      },
    };
  }

  // Current present.
  if (entry === undefined) {
    // present + no entry: refuse never-collected paths before the delete, so a
    // raw revert can never delete e.g. .git/config or .cc-web-*.tmp leftovers.
    if (isNeverCollectedPath(request.path))
      return refuse("FILE_UNSUPPORTED", "path is not part of the collectable workspace");
    // present + no entry -> delete the regular file.
    await rm(resolved.absolutePath);
    return {
      type: "rpc.result",
      commandId,
      ok: true,
      result: { op: "file.revert", path: request.path, action: "deleted", hash: null, size: null },
    };
  }

  if (entry.state === "excluded") {
    // present + excluded entry -> FILE_UNSUPPORTED with the row's reason.
    return refuse("FILE_UNSUPPORTED", entry.reason ?? "file was excluded from baseline");
  }

  // present + kept entry -> restore the blob bytes with the entry's stored mode.
  const blob = blobPath(homeDir, entry.hash!);
  let bytes: Buffer;
  try {
    bytes = await readFile(blob);
  } catch {
    return refuse("FILE_UNWRITABLE", "baseline blob could not be read");
  }
  const mode = entry.mode ?? 0o644;
  await writeAtomic(resolved.absolutePath, bytes, mode);
  const hash = sha256(bytes);
  return {
    type: "rpc.result",
    commandId,
    ok: true,
    result: { op: "file.revert", path: request.path, action: "restored", hash, size: bytes.length },
  };
}

/**
 * `workspace.revert`: apply a previewed whole-workspace revert.
 *
 * §7.8 two-phase flow: the operator reviewed a `snapshot.status` preview with its
 * digest, and the apply supplies that digest. The runner recomputes the plan and
 * refuses unless the world still matches.
 *
 * Rulings applied from the task brief:
 *  - restore mode comes from the manifest; restored files default to 0o644 when the
 *    manifest's mode is null (SnapshotEntry carries no mode — protocol shape unchanged);
 *  - MAX_REVERT_FILES counts the entries the apply acts on (modified + deleted +
 *    created; excluded untouched and uncounted); MAX_REVERT_BYTES sums the restore
 *    payload sizes for entries needing a blob read (modified + deleted; created is 0);
 *  - a null digest means the plan is unplannable -> PLAN_TOO_LARGE;
 *  - sentinels lock: acquireWorkspaceLock(db, root, `revert:<commandId>`);
 *  - a second digest mismatch under the lock is REVERT_STALE;
 *  - a per-file re-verify mismatch mid-apply yields a best-effort
 *    `{ planDigest, restored, deleted, failed: { path, code } }` result.
 */
async function workspaceRevert(
  commandId: string,
  root: string,
  homeDir: string,
  db: import("bun:sqlite").Database,
  request: { op: "workspace.revert"; planDigest: string },
  spawn?: GitSpawn,
): Promise<RpcResultFrame> {
  function refuse(code: string, message: string): RpcResultFrame {
    return { type: "rpc.result", commandId, ok: false, error: { code, message } };
  }

  // 1. NO_SNAPSHOT / SNAPSHOT_INCOMPARABLE: there must be a baseline to revert to,
  //    and the collector mode must be reproducible.
  const snapshot = latestSnapshot(db, root);
  if (snapshot === undefined) return refuse("NO_SNAPSHOT", "no baseline snapshot is available for revert");

  const planOptions = spawn === undefined ? { db } : { db, spawn };
  const computed = await computeSnapshotPlan(planOptions, root);
  if ("code" in computed) {
    // computeSnapshotPlan only returns NO_SNAPSHOT/SNAPSHOT_INCOMPARABLE; NO_SNAPSHOT
    // is already asserted above, but keep the guard for completeness.
    return refuse(computed.code, "cannot build a revert plan for this workspace");
  }
  const plan: SnapshotStatusResult = computed.plan;
  // computeSnapshotPlan returns a plan only when a baseline exists, so baseline is
  // non-null here; assert it for the type checker.
  if (plan.baseline === null) return refuse("NO_SNAPSHOT", "no baseline snapshot is available for revert");

  // 2. A partial baseline leaves the delete set unknowable: bulk revert is unsafe.
  if (plan.baseline.partial) return refuse("SNAPSHOT_PARTIAL", "baseline was truncated; bulk revert is unsafe");

  // 3. Truncated status, or a null (unplannable) digest -> PLAN_TOO_LARGE.
  if (plan.truncated || plan.digest === null)
    return refuse("PLAN_TOO_LARGE", "plan is truncated or unplannable");

  // 4. Budget check before the digest comparison (§7.8 ordering): the apply only acts
  //    on revertable entries. A plan that is both over budget and stale must refuse
  //    PLAN_TOO_LARGE, not REVERT_STALE.
  const actable = plan.entries.filter((e) => e.revertable);
  if (actable.length > MAX_REVERT_FILES)
    return refuse("PLAN_TOO_LARGE", "plan exceeds the per-revert file budget");

  // Restore payload size = the baseline blob size for modified/deleted (entries needing a
  // blob read); created entries contribute 0 (no blob). Stat the blobs on disk — the
  // content-addressed blob size equals the manifest size.
  let restoreBytes = 0;
  for (const e of actable) {
    if (e.status === "created") continue; // no blob read, size 0 for the sum.
    const blob = blobPath(homeDir, e.snapshotHash!);
    let info: { size: number };
    try {
      info = await stat(blob);
    } catch {
      return refuse("PLAN_TOO_LARGE", "baseline blob for plan size is missing");
    }
    restoreBytes += info.size;
  }
  if (restoreBytes > MAX_REVERT_BYTES)
    return refuse("PLAN_TOO_LARGE", "plan exceeds the per-revert byte budget");

  // 5. The caller's digest must match the freshly computed plan. A preview that no
  //    longer matches the tree is refused before any mutation.
  if (plan.digest !== request.planDigest)
    return refuse("REVERT_STALE", "workspace state changed since the plan was previewed");

  // 6. Sentinel lock. A run start during the apply observes this holder and is
  //    answered WORKSPACE_BUSY through the existing lock translation; re-issuing
  //    the same holder id is a no-op so a retry lands cleanly.
  const holderId = `revert:${commandId}`;
  if (!acquireWorkspaceLock(db, root, holderId)) {
    const holder = lockHolder(db, root);
    return refuse("WORKSPACE_BUSY", `workspace is currently locked by ${holder ?? "a holder"}`);
  }

  try {
    // 7. Re-verify under the lock: a second digest mismatch is REVERT_STALE. The
    //    preview -> apply race is the one this recompute closes.
    const recheckOptions = spawn === undefined ? { db } : { db, spawn };
    const rechecked = await computeSnapshotPlan(recheckOptions, root);
    if (!("code" in rechecked)) {
      const recheckPlan = rechecked.plan;
      if (recheckPlan.digest !== null && recheckPlan.digest !== request.planDigest)
        return refuse("REVERT_STALE", "workspace state changed during revert");
    }

    // 8. Apply in sorted order: restores/deletes first (blob reads), then creates
    //    (no blob), excluded untouched. Sort keeps the ordering deterministic and
    //    the result attributable to a single file when one fails.
    const sorted = [...actable].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    let restored = 0;
    let deleted = 0;
    let failed: { path: string; code: string } | null = null;

    for (const entry of sorted) {
      if (entry.status === "deleted") {
        // In baseline, absent now: restore the baseline blob for this path.
        const baselineEntry = snapshot.entries.find(
          (e) => e.path === entry.path && e.state === "kept",
        );
        if (baselineEntry === undefined) {
          // No kept baseline row but the plan says it should be restored: the
          // manifest is inconsistent with the plan. Treat as a per-file conflict.
          if (failed === null) failed = { path: entry.path, code: "FILE_CONFLICT" };
          break;
        }
        const blob = blobPath(homeDir, baselineEntry.hash!);
        let bytes: Buffer;
        try {
          bytes = await readFile(blob);
        } catch {
          if (failed === null) failed = { path: entry.path, code: "FILE_UNWRITABLE" };
          break;
        }
        // Re-verify the current state immediately before writing: the file must
        // still be absent (a second writer could have created it).
        const current = await readCurrent(join(root, entry.path));
        if (current.kind !== "absent") {
          if (failed === null) failed = { path: entry.path, code: "FILE_CONFLICT" };
          break;
        }
        const mode = baselineEntry.mode ?? 0o644;
        await writeAtomic(join(root, entry.path), bytes, mode);
        restored++;
      } else if (entry.status === "modified") {
        // Present now and in baseline: restore the baseline blob, re-verifying
        // the current hash matches the previewed currentHash first.
        const baselineEntry = snapshot.entries.find(
          (e) => e.path === entry.path && e.state === "kept",
        );
        if (baselineEntry === undefined) {
          if (failed === null) failed = { path: entry.path, code: "FILE_CONFLICT" };
          break;
        }
        const blob = blobPath(homeDir, baselineEntry.hash!);
        let bytes: Buffer;
        try {
          bytes = await readFile(blob);
        } catch {
          if (failed === null) failed = { path: entry.path, code: "FILE_UNWRITABLE" };
          break;
        }
        const current = await readCurrent(join(root, entry.path));
        if (current.kind !== "present" || current.hash !== entry.currentHash) {
          if (failed === null) failed = { path: entry.path, code: "FILE_CONFLICT" };
          break;
        }
        const mode = baselineEntry.mode ?? 0o644;
        await writeAtomic(join(root, entry.path), bytes, mode);
        restored++;
      } else if (entry.status === "created") {
        // Present now and not in baseline: delete the regular file only. Re-verify
        // the current state immediately before acting.
        const current = await readCurrent(join(root, entry.path));
        if (current.kind === "absent") {
          // The file vanished between preview and apply: conflict, stop.
          if (failed === null) failed = { path: entry.path, code: "FILE_CONFLICT" };
          break;
        }
        if (current.kind === "refused") {
          // Symlink / binary / oversize: the collector should not have listed it as
          // created, but a manifest inconsistency must not delete a non-regular file.
          if (failed === null) failed = { path: entry.path, code: current.code };
          break;
        }
        if (current.hash !== entry.currentHash) {
          if (failed === null) failed = { path: entry.path, code: "FILE_CONFLICT" };
          break;
        }
        // Guard never-collected paths: a created entry comes from the plan, and the
        // plan already excludes never-collected paths (the collector skips them), but
        // keep the guard so a manifest inconsistency cannot delete e.g. .git/config.
        if (isNeverCollectedPath(entry.path)) {
          if (failed === null) failed = { path: entry.path, code: "FILE_UNSUPPORTED" };
          break;
        }
        await rm(join(root, entry.path));
        deleted++;
      }
      // Excluded entries never reach here: they are filtered out of `actable`.
    }

    const result: WorkspaceRevertResult = {
      op: "workspace.revert",
      planDigest: request.planDigest,
      restored,
      deleted,
      failed,
    };
    return { type: "rpc.result", commandId, ok: true, result };
  } finally {
    releaseAttempt(db, `revert:${commandId}`);
  }
}
