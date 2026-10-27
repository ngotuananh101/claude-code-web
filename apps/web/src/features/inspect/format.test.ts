import { describe, expect, test } from "bun:test";
import { formatSize } from "./format.ts";

/**
 * Human size formatting for the Files panel (P3-A ruling 12).
 *
 * The runner reports byte counts; the panel shows them the way a file browser
 * does. Binary units, one decimal, trailing `.0` dropped so a round number
 * does not read as a measurement.
 */

describe("formatSize", () => {
  test("bytes below one unit stay whole", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(999)).toBe("999 B");
  });

  test("larger sizes switch units at 1024 and keep one decimal", () => {
    expect(formatSize(1024)).toBe("1 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1024 * 1024)).toBe("1 MB");
    expect(formatSize(1024 * 1024 * 1024)).toBe("1 GB");
  });

  test("a negative or fractional count is not a size", () => {
    expect(formatSize(-5)).toBe("0 B");
    expect(formatSize(10.7)).toBe("10 B");
  });
});
