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

/** Only text, untruncated reads with content can back an editor. */
export function isEditableRead(read: FileReadResult): boolean {
  return !read.binary && !read.truncated && read.content !== null;
}

/**
 * Why a non-editable read cannot open the dialog editor, or null when it can.
 * Binary files carry no content at all; truncated files carry only a prefix
 * the operator must not save back.
 */
export function editableReadNotice(read: FileReadResult): string | null {
  if (isEditableRead(read)) return null;
  if (read.binary) return "Tệp nhị phân — không mở được trình soạn thảo.";
  if (read.truncated) return "Nội dung đã được rút gọn — không mở được trình soạn thảo.";
  return "Không có nội dung để hiển thị.";
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
