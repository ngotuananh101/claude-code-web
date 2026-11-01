import { describe, expect, test } from "bun:test";
import { summariseLineChanges } from "./diff-stats.ts";

const change = (
  originalStartLineNumber: number,
  originalEndLineNumber: number,
  modifiedStartLineNumber: number,
  modifiedEndLineNumber: number,
) => ({
  originalStartLineNumber,
  originalEndLineNumber,
  modifiedStartLineNumber,
  modifiedEndLineNumber,
});

describe("summariseLineChanges", () => {
  test("counts added and removed lines across hunks", () => {
    // 3 lines replaced by 5, then 2 inserted further down.
    expect(summariseLineChanges([change(4, 6, 4, 8), change(10, 0, 12, 13)])).toEqual({
      added: 7,
      removed: 3,
    });
  });

  test("an empty side is end line 0 and contributes nothing", () => {
    // Insertion at the very top: Monaco reports start 0 / end 0 on the
    // original side, which must not count as one line.
    expect(summariseLineChanges([change(0, 0, 1, 2)])).toEqual({ added: 2, removed: 0 });
    // Deleting the whole file: the modified side is empty.
    expect(summariseLineChanges([change(1, 4, 0, 0)])).toEqual({ added: 0, removed: 4 });
  });

  test("no line changes means zero on both sides", () => {
    expect(summariseLineChanges([])).toEqual({ added: 0, removed: 0 });
  });
});
