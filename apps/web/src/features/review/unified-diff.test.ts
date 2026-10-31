import { describe, expect, test } from "bun:test";
import { parseUnifiedDiff, spliceOriginal } from "./unified-diff.ts";

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

test("reconstructs the hunk documents across multiple hunks", () => {
  // A partial-context `git diff` carries only the hunks: lines between them are
  // not in the diff at all. Reconstructing full documents needs the read of the
  // file on disk — see spliceOriginal below.
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
  expect(parsed!.original).toBe("");
  expect(parsed!.modified).toBe("one\ntwo\n");
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
  expect(parsed!.original).toBe("one\ntwo\n");
  expect(parsed!.modified).toBe("");
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
  expect(parsed!.original).toBe("old");
  expect(parsed!.modified).toBe("new\n");
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
    expect(parsed!.original).toBe("keep\nold\ntail\n");
    expect(parsed!.modified).toBe("keep\nnew\ntail\n");
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

const partialContextDiff = [
  "diff --git a/a.ts b/a.ts",
  "index 1111111..2222222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -3,7 +3,7 @@",
  " a3",
  " a4",
  " a5",
  "-a6",
  "+M6",
  " a7",
  " a8",
  " a9",
  "",
].join("\n");

const originalA =
  ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10", "a11", "a12"].join("\n") + "\n";
const modifiedA =
  ["a1", "a2", "a3", "a4", "a5", "M6", "a7", "a8", "a9", "a10", "a11", "a12"].join("\n") + "\n";

describe("spliceOriginal", () => {
  test("rebuilds the full original from the read document and the hunk ranges", () => {
    // A default-context `git diff` starts at line 3 here, so the parser's own
    // original is only the hunk fragment; the read document supplies the rest.
    const parsed = parseUnifiedDiff(partialContextDiff);
    expect(parsed).not.toBeNull();
    expect(parsed!.original).toBe("a3\na4\na5\na6\na7\na8\na9\n");
    expect(spliceOriginal(parsed!, modifiedA)).toBe(originalA);
  });

  test("keeps unchanged lines between hunks", () => {
    const diff = [
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1,4 +1,4 @@",
      " b1",
      "-b2",
      "+B2",
      " b3",
      " b4",
      "@@ -14,4 +14,4 @@",
      " b14",
      "-b15",
      "+B15",
      " b16",
      " b17",
      "",
    ].join("\n");
    const originalLines = Array.from({ length: 20 }, (_, i) => `b${i + 1}`);
    const modifiedLines = [...originalLines];
    modifiedLines[1] = "B2";
    modifiedLines[14] = "B15";
    const original = `${originalLines.join("\n")}\n`;
    const modified = `${modifiedLines.join("\n")}\n`;
    const parsed = parseUnifiedDiff(diff);
    expect(parsed).not.toBeNull();
    expect(spliceOriginal(parsed!, modified)).toBe(original);
  });

  test("refuses a document that no longer matches the diff", () => {
    const parsed = parseUnifiedDiff(partialContextDiff);
    expect(spliceOriginal(parsed!, modifiedA.replace("a7\n", "aX\n"))).toBeNull();
  });

  test("refuses a document too short for the hunk range", () => {
    const parsed = parseUnifiedDiff(partialContextDiff);
    expect(spliceOriginal(parsed!, "a1\na2\n")).toBeNull();
  });

  test("handles a hunk with no added lines", () => {
    const diff = [
      "diff --git a/c.ts b/c.ts",
      "--- a/c.ts",
      "+++ b/c.ts",
      "@@ -2,4 +2,2 @@",
      " c2",
      "-c3",
      "-c4",
      " c5",
      "",
    ].join("\n");
    const parsed = parseUnifiedDiff(diff);
    expect(spliceOriginal(parsed!, "c1\nc2\nc5\nc6\n")).toBe("c1\nc2\nc3\nc4\nc5\nc6\n");
  });

  test("preserves CRLF line endings through parse and splice", () => {
    const diff = [
      "diff --git a/d.txt b/d.txt",
      "--- a/d.txt",
      "+++ b/d.txt",
      "@@ -1,3 +1,3 @@",
      " d1\r",
      "-d2\r",
      "+D2\r",
      " d3\r",
      "",
    ].join("\n");
    const parsed = parseUnifiedDiff(diff);
    expect(parsed).not.toBeNull();
    expect(parsed!.original).toBe("d1\r\nd2\r\nd3\r\n");
    expect(spliceOriginal(parsed!, "d1\r\nD2\r\nd3\r\n")).toBe("d1\r\nd2\r\nd3\r\n");
  });

  test("honors a missing trailing newline on the original side", () => {
    const diff = [
      "diff --git a/e.ts b/e.ts",
      "--- a/e.ts",
      "+++ b/e.ts",
      "@@ -1,2 +1,2 @@",
      " e1",
      "-e2",
      "\\ No newline at end of file",
      "+E2",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const parsed = parseUnifiedDiff(diff);
    expect(spliceOriginal(parsed!, "e1\nE2")).toBe("e1\ne2");
  });
});
