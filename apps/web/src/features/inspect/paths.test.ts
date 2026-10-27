import { describe, expect, test } from "bun:test";
import { breadcrumbs, joinPath, parentPath } from "./paths.ts";

/**
 * Path arithmetic for the Files panel (P3-A ruling 12).
 *
 * One directory per call is the runner's bound, so the panel navigates by
 * composing paths from what it already knows — no recursive tree, no second
 * request to walk up. These are the pure pieces of that navigation.
 */

describe("breadcrumbs", () => {
  test("the workspace root has no crumbs", () => {
    expect(breadcrumbs("")).toEqual([]);
  });

  test("each crumb carries the cumulative path it links to", () => {
    expect(breadcrumbs("src/app/main.ts")).toEqual([
      { name: "src", path: "src" },
      { name: "app", path: "src/app" },
      { name: "main.ts", path: "src/app/main.ts" },
    ]);
  });

  test("stray leading, trailing and doubled slashes do not produce empty crumbs", () => {
    expect(breadcrumbs("/src//app/")).toEqual([
      { name: "src", path: "src" },
      { name: "app", path: "src/app" },
    ]);
  });
});

describe("parentPath", () => {
  test("the root has no parent", () => {
    expect(parentPath("")).toBeUndefined();
  });

  test("a top-level entry's parent is the root", () => {
    expect(parentPath("src")).toBe("");
  });

  test("a nested entry's parent is its directory", () => {
    expect(parentPath("src/app/main.ts")).toBe("src/app");
  });
});

describe("joinPath", () => {
  test("joining onto the root yields the bare name", () => {
    expect(joinPath("", "README.md")).toBe("README.md");
  });

  test("joining onto a directory yields one segment more", () => {
    expect(joinPath("src/app", "main.ts")).toBe("src/app/main.ts");
  });
});
