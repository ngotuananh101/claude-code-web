import { describe, expect, test } from "bun:test";
import { isDirty, viewerAfterSave } from "./edit.ts";

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
