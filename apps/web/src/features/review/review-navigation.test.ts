import { describe, expect, test } from "bun:test";
import {
  findNextPath,
  findNextUnreviewedPath,
  findPrevPath,
  formatFileCounter,
  nextPathAfterToggleReview,
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

  test("nextPathAfterToggleReview advances past reviewed files, treating current as reviewed", () => {
    const reviewed = new Set(["fileB.ts"]);
    const isPathReviewed = (path: string) => reviewed.has(path);

    // Current fileA is being marked reviewed; fileB is already reviewed, so
    // the dialog must skip it and land on fileC.
    expect(
      nextPathAfterToggleReview({
        paths,
        currentPath: "fileA.ts",
        alreadyReviewed: false,
        isPathReviewed,
      }),
    ).toBe("fileC.ts");
  });

  test("nextPathAfterToggleReview returns null when unmarking a reviewed file", () => {
    const isPathReviewed = () => false;
    // Toggling a reviewed file removes the mark; navigating away would hide
    // the unmark from the operator.
    expect(
      nextPathAfterToggleReview({
        paths,
        currentPath: "fileA.ts",
        alreadyReviewed: true,
        isPathReviewed,
      }),
    ).toBeNull();
  });

  test("nextPathAfterToggleReview closes the dialog once every other file is reviewed", () => {
    const reviewed = new Set(["fileB.ts", "fileC.ts"]);
    const isPathReviewed = (path: string) => reviewed.has(path);
    expect(
      nextPathAfterToggleReview({
        paths,
        currentPath: "fileA.ts",
        alreadyReviewed: false,
        isPathReviewed,
      }),
    ).toBeNull();
  });
});
