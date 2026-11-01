import { expect, test } from "bun:test";
import {
  defaultDiffMode,
  isReviewed,
  isReviewedByPath,
  lineSeparatorFor,
  resolveIncoming,
  reviewKey,
} from "./review-state.ts";

test("defaultDiffMode prefers unified on a 420px panel and split when wide", () => {
  expect(defaultDiffMode(420)).toBe("unified");
  expect(defaultDiffMode(719)).toBe("unified");
  expect(defaultDiffMode(720)).toBe("split");
  expect(defaultDiffMode(1024)).toBe("split");
});

test("a clean draft always adopts a fresh read", () => {
  expect(resolveIncoming({ currentHash: "h1", incomingHash: "h1", draftDirty: false })).toBe(
    "adopt",
  );
  expect(resolveIncoming({ currentHash: "h1", incomingHash: "h2", draftDirty: false })).toBe(
    "adopt",
  );
});

test("a dirty draft with an unchanged hash keeps the draft without a conflict", () => {
  expect(resolveIncoming({ currentHash: "h1", incomingHash: "h1", draftDirty: true })).toBe(
    "adopt-keep-draft",
  );
});

test("a dirty draft whose file changed on the runner conflicts", () => {
  expect(resolveIncoming({ currentHash: "h1", incomingHash: "h2", draftDirty: true })).toBe(
    "conflict",
  );
});

test("reviewed keys are path- and hash-scoped", () => {
  const reviewed = new Set([reviewKey("src/a.ts", "h1")]);
  expect(isReviewed(reviewed, "src/a.ts", "h1")).toBe(true);
  expect(isReviewed(reviewed, "src/a.ts", "h2")).toBe(false);
  expect(isReviewed(reviewed, "src/b.ts", "h1")).toBe(false);
});

test("isReviewedByPath matches the hash recorded when the file was opened", () => {
  const hashes = new Map([
    ["src/a.ts", "h1"],
    ["src/b.ts", "h2"],
  ]);
  const reviewed = new Set([reviewKey("src/a.ts", "h1")]);

  expect(isReviewedByPath(reviewed, hashes, "src/a.ts")).toBe(true);
  // A path whose content hash changed is no longer the reviewed revision.
  reviewed.add(reviewKey("src/b.ts", "old"));
  expect(isReviewedByPath(reviewed, hashes, "src/b.ts")).toBe(false);
  // A path never opened has no recorded hash and cannot be reviewed.
  expect(isReviewedByPath(new Set([reviewKey("src/c.ts", "")]), hashes, "src/c.ts")).toBe(false);
});

test("lineSeparatorFor detects CRLF text only", () => {
  expect(lineSeparatorFor("")).toBeNull();
  expect(lineSeparatorFor("a\nb\n")).toBeNull();
  expect(lineSeparatorFor("a\r\nb\r\n")).toBe("\r\n");
  // Mixed endings keep CRLF as the document separator so the untouched lines
  // round-trip byte for byte.
  expect(lineSeparatorFor("a\r\nb\nc")).toBe("\r\n");
});
