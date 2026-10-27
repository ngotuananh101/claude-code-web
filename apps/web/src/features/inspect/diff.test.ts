import { describe, expect, test } from "bun:test";
import { classifyDiffLines } from "./diff.ts";

/**
 * Diff line classification for the Changes panel (P3-A ruling 12).
 *
 * The runner returns unified diff text; the panel only needs to know how to
 * tint each line. No merge view, no accept/reject — §16.4 keeps those out until
 * there is an editor whose state they could change.
 */

describe("classifyDiffLines", () => {
  test("marks headers as meta, not as added or removed content", () => {
    const lines = classifyDiffLines(
      ["diff --git a/a.ts b/a.ts", "index 123..456 100644", "--- a/a.ts", "+++ b/a.ts"].join("\n"),
    );

    // `+++`/`---` start with the same characters as content, so the header
    // rules must win — otherwise every file's first lines look like edits.
    expect(lines.map((line) => line.kind)).toEqual(["meta", "meta", "meta", "meta"]);
  });

  test("classifies a hunk with additions, removals and context", () => {
    const diff = [
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " const c = 4;",
    ].join("\n");

    expect(classifyDiffLines(diff).map((line) => [line.kind, line.text])).toEqual([
      ["meta", "@@ -1,3 +1,3 @@"],
      ["context", " const a = 1;"],
      ["remove", "-const b = 2;"],
      ["add", "+const b = 3;"],
      ["context", " const c = 4;"],
    ]);
  });

  test("keeps the no-newline marker out of the content colours", () => {
    const lines = classifyDiffLines(["+x", "\\ No newline at end of file"].join("\n"));

    expect(lines[1]).toEqual({ kind: "meta", text: "\\ No newline at end of file" });
  });

  test("empty text classifies to no lines", () => {
    expect(classifyDiffLines("")).toEqual([]);
  });
});
