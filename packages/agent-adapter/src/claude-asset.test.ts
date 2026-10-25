import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { claudeCliPath } from "./claude-asset.ts";

describe("claudeCliPath", () => {
  test("names a CLI binary that exists on this host", () => {
    // From source this is the node_modules path; compiled, the extracted copy
    // under the per-user temp root. Either way it must be spawnable.
    expect(existsSync(claudeCliPath())).toBe(true);
  });
});
