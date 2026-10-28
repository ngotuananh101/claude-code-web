import type { FileReadResult, FileWriteResult } from "@cc-web/protocol";

/**
 * Pure editor logic for the Files tab (§7.11).
 *
 * `isDirty` is strict — a trailing-newline difference is a real edit the save
 * must carry, so there is no trimming or normalization. `viewerAfterSave`
 * hands the next save the hash the runner just returned, preserving every
 * other field of the read result so the next edit can diff against the fresh
 * token.
 */

export function isDirty(original: string, draft: string): boolean {
  return original !== draft;
}

export function viewerAfterSave(
  viewer: FileReadResult,
  draft: string,
  written: FileWriteResult,
): FileReadResult {
  return {
    op: "file.read",
    path: written.path,
    content: draft,
    binary: viewer.binary,
    truncated: viewer.truncated,
    hash: written.hash,
    size: written.size,
  };
}
