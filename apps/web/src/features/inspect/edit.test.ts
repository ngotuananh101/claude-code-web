import { describe, expect, test } from "bun:test";
import { editableReadNotice, isDirty, isEditableRead, viewerAfterSave } from "./edit.ts";

/**
 * Pure editor logic: dirty detection and the save-token handoff.
 *
 * `isDirty` is strict — a trailing-newline difference is a real edit the save
 * must carry, so there is no trimming or normalization. `viewerAfterSave` hands
 * the next save the hash the runner just returned, preserving every other field
 * of the read result so the next edit can diff against the fresh token.
 */

describe("isDirty", () => {
  test("dirty only when the draft differs", () => {
    expect(isDirty("a\n", "a\n")).toBe(false);
    expect(isDirty("a\n", "a")).toBe(true);
  });
});

describe("isEditableRead", () => {
  const base = { op: "file.read", path: "a.ts", hash: "h1", size: 3 } as const;

  test("only text, untruncated reads with content are editable", () => {
    expect(isEditableRead({ ...base, content: "text", binary: false, truncated: false })).toBe(
      true,
    );
    expect(isEditableRead({ ...base, content: null, binary: true, truncated: false })).toBe(false);
    expect(isEditableRead({ ...base, content: "cut", binary: false, truncated: true })).toBe(false);
    expect(isEditableRead({ ...base, content: null, binary: false, truncated: false })).toBe(false);
  });
});

describe("editableReadNotice", () => {
  const base = { op: "file.read", path: "a.ts", hash: "h1", size: 3 } as const;

  test("editable reads have no notice", () => {
    expect(
      editableReadNotice({ ...base, content: "text", binary: false, truncated: false }),
    ).toBeNull();
  });

  test("each non-editable read explains why it cannot open the editor", () => {
    expect(editableReadNotice({ ...base, content: null, binary: true, truncated: false })).toBe(
      "Tệp nhị phân — không mở được trình soạn thảo.",
    );
    expect(editableReadNotice({ ...base, content: "cut", binary: false, truncated: true })).toBe(
      "Nội dung đã được rút gọn — không mở được trình soạn thảo.",
    );
    expect(editableReadNotice({ ...base, content: null, binary: false, truncated: false })).toBe(
      "Không có nội dung để hiển thị.",
    );
  });
});

describe("viewerAfterSave", () => {
  test("a save hands the next save its token", () => {
    const viewer = {
      op: "file.read",
      path: "a.ts",
      content: "old",
      binary: false,
      truncated: false,
      hash: "h1",
      size: 3,
    } as const;
    expect(
      viewerAfterSave(viewer, "new", { op: "file.write", path: "a.ts", hash: "h2", size: 3 }),
    ).toEqual({
      op: "file.read",
      path: "a.ts",
      content: "new",
      binary: false,
      truncated: false,
      hash: "h2",
      size: 3,
    });
  });
});
