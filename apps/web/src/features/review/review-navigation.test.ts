import { describe, expect, test } from "bun:test";
import {
  findNextPath,
  findNextUnreviewedPath,
  findPrevPath,
  formatFileCounter,
} from "./review-navigation.ts";

describe("review-navigation", () => {
  const paths = ["fileA.ts", "fileB.ts", "fileC.ts"];

  test("findNextUnreviewedPath advances to next unreviewed file", () => {
    const reviewed = new Set(["fileA.ts"]);
    const isRev = (p: string) => reviewed.has(p);

    expect(findNextUnreviewedPath(paths, "fileA.ts", isRev)).toBe("fileB.ts");
  });

  test("findNextUnreviewedPath skips reviewed files and wraps around", () => {
    const reviewed = new Set(["fileB.ts"]);
    const isRev = (p: string) => reviewed.has(p);

    // Current is fileB, next unreviewed should be fileC
    expect(findNextUnreviewedPath(paths, "fileB.ts", isRev)).toBe("fileC.ts");

    // Current is fileC, next unreviewed should wrap to fileA
    expect(findNextUnreviewedPath(paths, "fileC.ts", isRev)).toBe("fileA.ts");
  });

  test("findNextUnreviewedPath returns null when all files are reviewed", () => {
    const reviewed = new Set(["fileA.ts", "fileB.ts", "fileC.ts"]);
    const isRev = (p: string) => reviewed.has(p);

    expect(findNextUnreviewedPath(paths, "fileB.ts", isRev)).toBeNull();
  });

  test("findPrevPath and findNextPath navigate circularly", () => {
    expect(findPrevPath(paths, "fileA.ts")).toBe("fileC.ts");
    expect(findPrevPath(paths, "fileB.ts")).toBe("fileA.ts");
    expect(findNextPath(paths, "fileC.ts")).toBe("fileA.ts");
    expect(findNextPath(paths, "fileA.ts")).toBe("fileB.ts");
  });

  test("formatFileCounter formats 1-based index and total count", () => {
    expect(formatFileCounter(paths, "fileA.ts")).toBe("1 / 3");
    expect(formatFileCounter(paths, "fileB.ts")).toBe("2 / 3");
    expect(formatFileCounter(paths, "unknown.ts")).toBe("0 / 3");
    expect(formatFileCounter([], "fileA.ts")).toBe("0 / 0");
  });
});
