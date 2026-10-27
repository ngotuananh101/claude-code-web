/**
 * Bounded workspace mutations (§7.1 write/revert lane).
 *
 * Three payloads ride on two existing command kinds plus one new kind:
 *   workspace.file.write  -> FileWriteRequest    -> FileWriteResult
 *   workspace.file.revert -> FileRevertRequest   -> FileRevertResult
 *   workspace.revert      -> WorkspaceRevertRequest -> WorkspaceRevertResult
 *
 * All three are gated by the `workspace.write` capability; the runner is the
 * only producer of results, so `parseRpcResultFrame` (in inspection.ts) accepts a
 * result whose `op` is any of the mutation results without narrowing.
 */

/** The capabilities entry a runner must advertise before it is sent write/revert commands. */
export const WRITE_CAPABILITY = "workspace.write" as const;

/** Largest file content the runner will keep in a single snapshot blob. */
export const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;
/** Largest total snapshot manifest the runner will retain for one run. */
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
/** Largest number of file entries a single snapshot manifest may contain. */
export const MAX_SNAPSHOT_ENTRIES = 10_000;
/** Largest number of status entries returned in one snapshot.status answer. */
export const MAX_STATUS_ENTRIES = 2000;
/** Largest plan a single workspace.revert apply will attempt. */
export const MAX_REVERT_FILES = 300;
/** Largest total bytes a single workspace.revert apply will attempt. */
export const MAX_REVERT_BYTES = 16 * 1024 * 1024;
/** Number of baseline snapshots retained per workspace. */
export const SNAPSHOT_RETENTION = 5;

/** A revision-checked save of one file's contents. */
export type FileWriteRequest = {
  op: "file.write";
  path: string;
  content: string;
  expectedHash: string;
};
/**
 * Restore one file to its baseline, or delete a file the baseline says was
 * created during the run. `expectedHash === null` asserts the path is absent.
 */
export type FileRevertRequest = { op: "file.revert"; path: string; expectedHash: string | null };
/** Restore the whole workspace to the baseline the snapshot status previewed. */
export type WorkspaceRevertRequest = { op: "workspace.revert"; planDigest: string };
export type MutationRequest = FileWriteRequest | FileRevertRequest | WorkspaceRevertRequest;

/** The runner's answer to a `file.write`. */
export type FileWriteResult = { op: "file.write"; path: string; hash: string; size: number };
/** The runner's answer to a `file.revert`. */
export type FileRevertResult = {
  op: "file.revert";
  path: string;
  action: "restored" | "deleted" | "none";
  hash: string | null;
  size: number | null;
};
/** The runner's answer to a `workspace.revert`. */
export type WorkspaceRevertResult = {
  op: "workspace.revert";
  planDigest: string;
  restored: number;
  deleted: number;
  failed: { path: string; code: string } | null;
};
export type MutationResult = FileWriteResult | FileRevertResult | WorkspaceRevertResult;

/**
 * Parse a mutation command payload.
 *
 * The kind decides which ops are addressable, exactly as `parseInspectRequest`
 * does: dispatching a `file.revert` that arrived under `workspace.file.write`
 * would mean the vocabulary is the payload's to choose, not the command kind's.
 * `undefined` is the refusal signal, matching that parser's idiom.
 */
export function parseMutationRequest(kind: string, payload: unknown): MutationRequest | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const op = record["op"];

  if (kind === "workspace.file.write" && op === "file.write") {
    const path = record["path"],
      content = record["content"],
      expectedHash = record["expectedHash"];
    if (
      typeof path !== "string" ||
      typeof content !== "string" ||
      typeof expectedHash !== "string"
    ) {
      return undefined;
    }
    return { op, path, content, expectedHash };
  }

  if (kind === "workspace.file.revert" && op === "file.revert") {
    const path = record["path"],
      expectedHash = record["expectedHash"];
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
