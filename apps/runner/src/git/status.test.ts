import { describe, expect, test } from "bun:test";
import { parsePorcelainStatus } from "./status.ts";

/**
 * `git status --porcelain=v1 -z` into typed change entries (§15.2).
 *
 * The `-z` form is what makes this unambiguous: paths with spaces or quotes are
 * NUL-terminated rather than quoted, and a rename carries its original path as
 * the *next* field rather than inline. The tests feed literal output so the
 * field layout is pinned here, not inferred from a live repository.
 */

describe("parsePorcelainStatus", () => {
  test("parses modified, added, deleted and untracked entries", () => {
    const out = " M src/a.ts\0A  src/b.ts\0 D src/c.ts\0?? src/d.ts\0";
    expect(parsePorcelainStatus(out)).toEqual({
      entries: [
        { path: "src/a.ts", status: "modified" },
        { path: "src/b.ts", status: "added" },
        { path: "src/c.ts", status: "deleted" },
        { path: "src/d.ts", status: "untracked" },
      ],
      truncated: false,
    });
  });

  test("parses a rename with its original path", () => {
    const out = "R  new.ts\0old.ts\0";
    expect(parsePorcelainStatus(out)).toEqual({
      entries: [{ path: "new.ts", status: "renamed", origPath: "old.ts" }],
      truncated: false,
    });
  });

  test("parses a copy with its original path", () => {
    expect(parsePorcelainStatus("C  copy.ts\0source.ts\0").entries).toEqual([
      { path: "copy.ts", status: "copied", origPath: "source.ts" },
    ]);
  });

  test("parses a conflicted entry", () => {
    expect(parsePorcelainStatus("UU conflicted.ts\0").entries).toEqual([
      { path: "conflicted.ts", status: "conflicted" },
    ]);
  });

  test("parses a staged-and-modified entry as added, the index letter", () => {
    // `AM` is added to the index and modified in the tree. The first column is
    // the index status, and that is what a change list is asking about.
    expect(parsePorcelainStatus("AM a.ts\0").entries).toEqual([{ path: "a.ts", status: "added" }]);
  });

  test("parses a typechange entry", () => {
    expect(parsePorcelainStatus(" T link.ts\0").entries).toEqual([
      { path: "link.ts", status: "typechange" },
    ]);
  });

  test("truncates past the limit", () => {
    const out = Array.from({ length: 5 }, (_, i) => ` M f${i}.ts\0`).join("");
    expect(parsePorcelainStatus(out, 2)).toEqual({
      entries: [
        { path: "f0.ts", status: "modified" },
        { path: "f1.ts", status: "modified" },
      ],
      truncated: true,
    });
  });

  test("tolerates empty output and a trailing separator", () => {
    expect(parsePorcelainStatus("")).toEqual({ entries: [], truncated: false });
    expect(parsePorcelainStatus(" M a.ts\0").entries.length).toBe(1);
  });

  test("keeps a path containing a space or a quote intact", () => {
    // This is the whole reason for `-z`: no quoting, no ambiguity.
    expect(parsePorcelainStatus(' M "dir with space/a.ts"\0').entries).toEqual([
      { path: '"dir with space/a.ts"', status: "modified" },
    ]);
    expect(parsePorcelainStatus(" M a b.ts\0").entries).toEqual([
      { path: "a b.ts", status: "modified" },
    ]);
  });

  test("skips a malformed record rather than inventing a status", () => {
    expect(parsePorcelainStatus("XY\0").entries).toEqual([]);
  });
});
