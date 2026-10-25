import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetDecision,
  parseArgs,
  registryMetadataUrl,
  registryTarballUrl,
} from "./claude-target-asset.ts";

describe("assetDecision", () => {
  test("a missing directory is missing", () => {
    expect(assetDecision(join(tmpdir(), "cc-web-no-such-asset-dir"), "0.3.309")).toBe("missing");
  });

  test("a matching version is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-web-asset-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.3.309" }));
    expect(assetDecision(dir, "0.3.309")).toBe("present");
  });

  test("a different version is stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-web-asset-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.2.0" }));
    expect(assetDecision(dir, "0.3.309")).toBe("stale");
  });

  test("an unreadable package.json is stale, not trusted", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-web-asset-"));
    writeFileSync(join(dir, "package.json"), "{not json");
    expect(assetDecision(dir, "0.3.309")).toBe("stale");
  });

  test("an empty directory is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-web-asset-"));
    expect(assetDecision(dir, "0.3.309")).toBe("missing");
  });
});

describe("registry urls", () => {
  test("tarball url follows the npm registry layout", () => {
    expect(registryTarballUrl("@anthropic-ai/claude-agent-sdk-win32-x64", "0.3.309")).toBe(
      "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-win32-x64/-/claude-agent-sdk-win32-x64-0.3.309.tgz",
    );
  });

  test("metadata url is the registry's versioned document", () => {
    expect(registryMetadataUrl("@anthropic-ai/claude-agent-sdk-linux-arm64", "0.3.309")).toBe(
      "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-arm64/0.3.309",
    );
  });
});

describe("parseArgs", () => {
  test("defaults to the host target", () => {
    expect(parseArgs([])).toEqual({ target: "host" });
  });

  test("accepts both flag forms", () => {
    expect(parseArgs(["--target", "bun-windows-x64"])).toEqual({ target: "bun-windows-x64" });
    expect(parseArgs(["--target=bun-linux-arm64"])).toEqual({ target: "bun-linux-arm64" });
  });

  test("an unknown flag is refused", () => {
    expect(() => parseArgs(["--frobnicate"])).toThrow();
  });
});
