/**
 * Bounded inspection RPC (§23).
 *
 * Commands are one-way: the durable outbox, the runner inbox, the receipt. The
 * only traffic that returns is the acceptance receipt and run-scoped events, and
 * an inspection has no run — a read-only question about a workspace must not
 * invent an attempt to ride on. `rpc.result` is therefore a fourth inbound frame
 * beside `hello`, `reconcile`, `command.receipt` and `events`, deliberately not
 * an `EventType`: events carry `sessionId`/`runId`/`attemptId`, are journaled
 * with a session sequence and replayed to browsers (§12.1, §12.2), and none of
 * that is true or wanted here.
 *
 * Both parsers below sit at an untrusted boundary (§9.1's pattern): the payload
 * a server wrote into a command, and the frame a runner sends back. Each rebuilds
 * an object from known keys rather than forwarding what it was handed, so a
 * field nobody defined cannot ride along. Neither validates the path: path safety
 * belongs to the runner, which owns the filesystem (Task 3). A parser refusing
 * `..` here would be a second, weaker copy of the rule that actually matters.
 */

import type { MutationResult } from "./mutation.ts";

/** The `capabilities` entry a runner must advertise before it is sent RPCs. */
export const INSPECT_CAPABILITY = "inspect" as const;

/** Directory listing ceiling; a deeper tree is reported as truncated, not read. */
export const MAX_LISTING_ENTRIES = 2000;
/** Largest file content the runner will return in one result. */
export const MAX_FILE_BYTES = 1024 * 1024;
/** Largest diff the runner will return in one result. */
export const MAX_DIFF_BYTES = 256 * 1024;
/**
 * How much of a file is sampled to decide whether it is binary. Git's own
 * heuristic: the first 8000 bytes, a NUL byte meaning not-text.
 */
export const BINARY_SNIFF_BYTES = 8000;
/** Working-tree change ceiling, mirroring the listing bound. */
export const MAX_CHANGE_ENTRIES = 2000;

/** Porcelain status letters, expanded to the words a UI can render directly. */
export type ChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted"
  | "typechange";

/**
 * A question about the workspace the command names. The runner resolves the
 * path from its own registration (Ruling 11), so no absolute path crosses the
 * wire in either direction; `path` is always relative to the workspace root.
 */
export type WorkspaceInspectRequest =
  | { op: "file.list"; path: string }
  | { op: "file.read"; path: string }
  | { op: "git.diff"; path: string }
  | { op: "git.changes" }
  | { op: "snapshot.status" };

/**
 * A question about the runner's own configuration. It carries a `workspaceId`
 * at the command level like the others — the report names the workspace root it
 * resolved, and a config-only command would otherwise be the one kind the
 * runner could not answer about a specific workspace.
 */
export type ConfigInspectRequest = { op: "diagnostics" };

export type InspectRequest = WorkspaceInspectRequest | ConfigInspectRequest;

/**
 * Runner configuration, reported for support. Every field is a fact about
 * configuration, never its content: whether a source file exists and is
 * readable, whether git is on the PATH, whether provider auth is present. No
 * path outside the workspace, no environment value, no token (§19.4).
 */
export type DiagnosticsReport = {
  protocolVersion: number;
  runtime: string;
  workspaceRoot: string;
  sources: Array<{
    source: "user" | "project" | "local";
    path: string;
    exists: boolean;
    readable: boolean;
  }>;
  gitAvailable: boolean;
  providerAuth: "configured" | "missing" | "unknown";
  warnings: string[];
};

export type FileListResult = {
  op: "file.list";
  path: string;
  entries: Array<{ name: string; kind: "file" | "directory" | "other"; size: number }>;
  truncated: boolean;
};

export type FileReadResult = {
  op: "file.read";
  path: string;
  /**
   * `null` when the file was refused as binary; the reason lives in `binary`,
   * not in a string that a caller might render.
   */
  content: string | null;
  binary: boolean;
  truncated: boolean;
  hash: string;
  size: number;
};

export type GitChangesResult = {
  op: "git.changes";
  entries: Array<{ path: string; status: ChangeStatus; origPath?: string }>;
  truncated: boolean;
};

export type GitDiffResult = {
  op: "git.diff";
  path: string;
  diff: string;
  truncated: boolean;
};

export type DiagnosticsResult = { op: "diagnostics"; report: DiagnosticsReport };

export type SnapshotEntry = {
  path: string;
  status: "modified" | "created" | "deleted" | "excluded";
  snapshotHash: string | null; currentHash: string | null;
  size: number | null;
  revertable: boolean;
  reason?: string;
};

export type SnapshotStatusResult = {
  op: "snapshot.status";
  baseline: {
    attemptId: string; sessionId: string | null;
    capturedAt: string; partial: boolean; fileCount: number;
  } | null;
  entries: SnapshotEntry[];
  counts: { modified: number; created: number; deleted: number; excluded: number };
  digest: string | null;
  truncated: boolean;
};

export type InspectResult =
  | FileListResult
  | FileReadResult
  | GitChangesResult
  | GitDiffResult
  | DiagnosticsResult
  | SnapshotStatusResult;

/**
 * Runner → Server: the answer to one inspection command.
 *
 * `ok: false` is a refusal the server must surface as-is — the runner is the
 * side that knows why it said no. A `rpc.result` retires the outbox row and
 * settles the waiter; there is no receipt, because an inspection is not an
 * attempt (§9.1 acceptance applies to commands that start work).
 */
export type RpcResultFrame = {
  type: "rpc.result";
  commandId: string;
  ok: boolean;
  result?: InspectResult | MutationResult;
  error?: { code: string; message: string };
};

/**
 * Parse the payload of an `workspace.inspect` or `config.inspect` command.
 *
 * `undefined` is the refusal signal, matching the other protocol parsers. The
 * kind decides which ops are addressable: dispatching a `file.read` that
 * arrived under `config.inspect` would mean the vocabulary is the payload's to
 * choose, not the command kind's.
 */
export function parseInspectRequest(kind: string, payload: unknown): InspectRequest | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const op = record["op"];

  if (kind === "workspace.inspect") {
    if (op === "git.changes") return { op: "git.changes" };
    if (op === "snapshot.status") return { op: "snapshot.status" };
    if (op === "file.list" || op === "file.read" || op === "git.diff") {
      const path = record["path"];
      if (typeof path !== "string") return undefined;
      return { op, path };
    }
    return undefined;
  }

  if (kind === "config.inspect") {
    if (op === "diagnostics") return { op: "diagnostics" };
    return undefined;
  }

  return undefined;
}

/**
 * Parse an inbound `rpc.result` frame. The server holds a waiter per command
 * id; a frame it cannot read is dropped rather than matched loosely, because a
 * loosely matched answer would settle the wrong request.
 */
export function parseRpcResultFrame(value: unknown): RpcResultFrame | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record["type"] !== "rpc.result") return undefined;

  const commandId = record["commandId"];
  if (typeof commandId !== "string" || commandId === "") return undefined;

  const ok = record["ok"];
  if (typeof ok !== "boolean") return undefined;

  if (ok) {
    const result = record["result"];
    if (typeof result !== "object" || result === null) return undefined;
    const op = (result as Record<string, unknown>)["op"];
    if (typeof op !== "string") return undefined;
    return { type: "rpc.result", commandId, ok, result: result as InspectResult | MutationResult };
  }

  const error = record["error"];
  if (typeof error !== "object" || error === null) return undefined;
  const errorRecord = error as Record<string, unknown>;
  const code = errorRecord["code"];
  const message = errorRecord["message"];
  if (typeof code !== "string" || typeof message !== "string") return undefined;
  return { type: "rpc.result", commandId, ok, error: { code, message } };
}
