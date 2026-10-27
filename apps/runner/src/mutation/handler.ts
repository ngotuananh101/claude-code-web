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
import { chmod, lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BINARY_SNIFF_BYTES,
  MAX_SNAPSHOT_FILE_BYTES,
  type MutationRequest,
  type MutationResult,
  parseMutationRequest,
  type RpcResultFrame,
  WRITE_CAPABILITY,
} from "@cc-web/protocol";
import { latestSnapshot, lockHolder } from "@cc-web/runner-db";
import { redactErrorText } from "../execution/redact.ts";
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
        return refuse(
          commandId,
          "UNSUPPORTED_COMMAND",
          "workspace.revert is not implemented in this runner",
        );
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

  // 6. expectedHash revision check (when not null).
  if (request.expectedHash !== null) {
    if (current.kind === "absent") {
      return refuse("FILE_CONFLICT", "expected hash does not match current content");
    }
    if (current.hash !== request.expectedHash) {
      return refuse("FILE_CONFLICT", "expected hash does not match current content");
    }
  }

  // 7. Revert table.
  if (current.kind === "absent") {
    // Current absent.
    if (entry === undefined) {
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
