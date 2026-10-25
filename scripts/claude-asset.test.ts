import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { claudeAssetTarget } from "../packages/agent-adapter/src/claude-asset-targets.ts";
import { generateShim } from "./claude-asset.ts";

const SHIM_PATH = new URL(
  "../packages/agent-adapter/src/claude-asset.generated.ts",
  import.meta.url,
).pathname;

describe("generateShim", () => {
  test("resolves only after the shim names the host target's binary", async () => {
    // The returned promise is the ordering guarantee build:runner relies on:
    // the shim must be on disk before the bundler reads it.
    const pending = generateShim("host");
    expect(pending).toBeInstanceOf(Promise);
    await pending;
    const asset = claudeAssetTarget("host");
    expect(readFileSync(SHIM_PATH, "utf8")).toContain(
      `import binPath from "${asset.pkg}/${asset.binary}"`,
    );
  });
});
