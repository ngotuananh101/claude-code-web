import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { claudeCliKind, embeddedCliPath } from "./claude-asset.ts";

describe("the build's CLI source", () => {
  test("an embedded build extracts a binary that exists on this host", () => {
    if (claudeCliKind() !== "embedded") return;
    const path = embeddedCliPath();
    expect(path).toBeDefined();
    expect(existsSync(path!)).toBe(true);
  });

  test("a slim build names no embedded path and import stays cheap", () => {
    if (claudeCliKind() !== "external") return;
    expect(embeddedCliPath()).toBeUndefined();
  });
});
