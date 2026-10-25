import { describe, expect, test } from "bun:test";
import { claudeAssetTarget } from "./claude-asset-targets.ts";

describe("claudeAssetTarget", () => {
  test("maps the four release targets to their platform packages", () => {
    expect(claudeAssetTarget("bun-linux-x64")).toEqual({
      pkg: "@anthropic-ai/claude-agent-sdk-linux-x64",
      binary: "claude",
    });
    expect(claudeAssetTarget("bun-linux-arm64")).toEqual({
      pkg: "@anthropic-ai/claude-agent-sdk-linux-arm64",
      binary: "claude",
    });
    expect(claudeAssetTarget("bun-windows-x64")).toEqual({
      pkg: "@anthropic-ai/claude-agent-sdk-win32-x64",
      binary: "claude.exe",
    });
    expect(claudeAssetTarget("bun-windows-arm64")).toEqual({
      pkg: "@anthropic-ai/claude-agent-sdk-win32-arm64",
      binary: "claude.exe",
    });
  });

  test("resolves the host itself without naming a platform twice", () => {
    // The dev/CI host is linux-x64; the mapping must agree with it.
    expect(claudeAssetTarget("host")).toEqual(claudeAssetTarget("bun-linux-x64"));
  });

  test("an unknown target is refused, not guessed", () => {
    expect(() => claudeAssetTarget("bun-freebsd-x64")).toThrow();
  });
});
