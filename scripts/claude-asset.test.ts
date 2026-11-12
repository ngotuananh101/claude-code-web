import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { claudeAssetTarget } from "../packages/agent-adapter/src/claude-asset-targets.ts";
import { generateShim } from "./claude-asset.ts";

const SHIM_PATH = new URL(
  "../packages/agent-adapter/src/claude-asset.generated.ts",
  import.meta.url,
).pathname;

describe("generateShim", () => {
  test("bundled shim names the host target's binary as a file asset", async () => {
    const pending = generateShim("host", "bundled");
    expect(pending).toBeInstanceOf(Promise);
    await pending;
    const asset = claudeAssetTarget("host");
    const shim = readFileSync(SHIM_PATH, "utf8");
    expect(shim).toContain(`import binPath from "${asset.pkg}/${asset.binary}"`);
    expect(shim).toContain('kind: "embedded"');
  });

  test("slim shim imports no platform package at all", async () => {
    await generateShim("host", "slim");
    const shim = readFileSync(SHIM_PATH, "utf8");
    expect(shim).toContain('kind: "external"');
    // A single static import is enough to pull 293 MB into the executable.
    expect(shim).not.toContain("@anthropic-ai/claude-agent-sdk-");
    expect(shim).not.toContain('with { type: "file" }');
  });

  test("the variant defaults to bundled", async () => {
    await generateShim("host");
    expect(readFileSync(SHIM_PATH, "utf8")).toContain('kind: "embedded"');
  });
});
