import { describe, expect, test } from "bun:test";
import { defaultDiffMode, isReviewed, resolveIncoming, reviewKey } from "./review-state.ts";

test("defaultDiffMode prefers unified on a 420px panel and split when wide", () => {
  expect(defaultDiffMode(420)).toBe("unified");
  expect(defaultDiffMode(719)).toBe("unified");
  expect(defaultDiffMode(720)).toBe("split");
  expect(defaultDiffMode(1024)).toBe("split");
});

test("a clean draft always adopts a fresh read", () => {
  expect(resolveIncoming({ currentHash: "h1", incomingHash: "h1", draftDirty: false })).toBe("adopt");
  expect(resolveIncoming({ currentHash: "h1", incomingHash: "h2", draftDirty: false })).toBe("adopt");
});

test("a dirty draft with an unchanged hash adopts the viewer without a conflict", () => {
  expect(resolveIncoming({ currentHash: "h1", incomingHash: "h1", draftDirty: true })).toBe("adopt");
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