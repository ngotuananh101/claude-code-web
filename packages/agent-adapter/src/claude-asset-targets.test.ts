import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

  test("macOS targets resolve too, so the postinstall works on a mac checkout", () => {
    // `host` goes through this map, and `bun install`'s postinstall generates
    // the host shim: without these, a mac developer's install throws.
    expect(claudeAssetTarget("bun-darwin-arm64")).toEqual({
      pkg: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
      binary: "claude",
    });
    expect(claudeAssetTarget("bun-darwin-x64")).toEqual({
      pkg: "@anthropic-ai/claude-agent-sdk-darwin-x64",
      binary: "claude",
    });
  });

  test("every mapped package exists in the SDK's own manifest", () => {
    // The SDK ships one package per platform it supports; a mapping that names
    // a package the SDK does not publish fails at install time on that host,
    // long after this map was written.
    const manifest = JSON.parse(
      readFileSync(
        new URL(
          "../../../node_modules/@anthropic-ai/claude-agent-sdk/manifest.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { platforms: Record<string, { binary: string }> };
    for (const target of [
      "bun-linux-x64",
      "bun-linux-arm64",
      "bun-windows-x64",
      "bun-windows-arm64",
      "bun-darwin-arm64",
      "bun-darwin-x64",
    ]) {
      const mapped = claudeAssetTarget(target);
      const platform = mapped.pkg.slice("@anthropic-ai/claude-agent-sdk-".length);
      expect(manifest.platforms[platform]?.binary).toBe(mapped.binary);
    }
  });
});
