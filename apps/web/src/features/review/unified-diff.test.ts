import { describe, expect, test } from "bun:test";
import { parseUnifiedDiff } from "./unified-diff.ts";

const twoHunks = [
  "diff --git a/a.ts b/a.ts",
  "index 1111111..2222222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
  "@@ -20,2 +21,2 @@",
  "-old line",
  "+new line",
  " tail",
  "",
].join("\n");

test("reconstructs both full documents across multiple hunks", () => {
  const parsed = parseUnifiedDiff(twoHunks);
  expect(parsed).not.toBeNull();
  expect(parsed!.original).toBe("const a = 1;\nconst b = 2;\nconst d = 5;\nold line\ntail\n");
  expect(parsed!.modified).toBe(
    "const a = 1;\nconst b = 3;\nconst c = 4;\nconst d = 5;\nnew line\ntail\n",
  );
});

test("a new file has an empty original side", () => {
  const parsed = parseUnifiedDiff(
    [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "",
    ].join("\n"),
  );
  expect(parsed).toEqual({ original: "", modified: "one\ntwo\n" });
});

test("a deleted file has an empty modified side", () => {
  const parsed = parseUnifiedDiff(
    [
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-one",
      "-two",
      "",
    ].join("\n"),
  );
  expect(parsed).toEqual({ original: "one\ntwo\n", modified: "" });
});

test("the no-newline marker adjusts only the side it follows", () => {
  const parsed = parseUnifiedDiff(
    [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "",
    ].join("\n"),
  );
  expect(parsed).toEqual({ original: "old", modified: "new\n" });
});

describe("context lines", () => {
  test("context lines inside a hunk belong to both sides", () => {
    const parsed = parseUnifiedDiff(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -2,3 +2,3 @@",
        " keep",
        "-old",
        "+new",
        " tail",
        "",
      ].join("\n"),
    );
    expect(parsed).toEqual({ original: "keep\nold\ntail\n", modified: "keep\nnew\ntail\n" });
  });
});

test("returns null for text that is not one complete text diff", () => {
  expect(parseUnifiedDiff("")).toBeNull();
  expect(parseUnifiedDiff("Binary files a/x.png and b/x.png differ\n")).toBeNull();
  expect(
    parseUnifiedDiff(
      [
        "diff --git a/a b/a",
        "--- a/a",
        "+++ b/a",
        "@@ -1 +1 @@",
        "-x",
        "+y",
        "diff --git a/c b/c",
        "--- a/c",
        "+++ b/c",
        "@@ -1 +1 @@",
        "-z",
        "+w",
        "",
      ].join("\n"),
    ),
  ).toBeNull();
  expect(parseUnifiedDiff("@@ -1 +1 @@\n-x\n+y\n")).toBeNull(); // no file headers
  expect(
    parseUnifiedDiff(
      ["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1,2 +1,2 @@", "-x", "+y", ""].join("\n"),
    ),
  ).toBeNull(); // hunk counts do not match the body
});

test("over-delivery past exhausted counts returns null", () => {
  // Hunk header claims 1 old / 1 new line, but the body has a second context
  // line after the counters are exhausted → null.
  const parsed = parseUnifiedDiff(
    [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,1 @@",
      " a",
      " b",
      "",
    ].join("\n"),
  );
  expect(parsed).toBeNull();
});
