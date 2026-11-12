import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { asset } from "./claude-asset.generated.ts";
import { type ClaudeAsset, claudeCliKind, embeddedCliPath } from "./claude-asset.ts";

describe("the build's CLI source", () => {
  test("names the kind the generated shim declares", () => {
    // Whichever shim is on disk, the adapter must report it — never a guess.
    const shim = asset as ClaudeAsset;
    expect(claudeCliKind()).toBe(shim.kind === "embedded" ? "embedded" : "external");
  });

  test("an embedded build extracts an existing binary; a slim build names none", () => {
    const path = embeddedCliPath();
    const shim = asset as ClaudeAsset;
    if (shim.kind === "embedded") {
      expect(path).toBeDefined();
      expect(existsSync(path as string)).toBe(true);
      return;
    }
    expect(path).toBeUndefined();
  });
});
