import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MIN_CLAUDE_CLI_VERSION } from "./claude-cli-version.ts";

describe("MIN_CLAUDE_CLI_VERSION", () => {
  test("matches the CLI version the installed SDK bundles", () => {
    // SDK 0.3.x bundles CLI 2.1.x in lockstep; the SDK's own manifest records
    // it. A dependency bump that forgets this constant would let the runner
    // accept a CLI missing options the adapter sets.
    const manifestUrl = new URL(
      "../../../node_modules/@anthropic-ai/claude-agent-sdk/manifest.json",
      import.meta.url,
    );
    const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as { version?: string };
    expect(typeof manifest.version).toBe("string");
    expect(MIN_CLAUDE_CLI_VERSION).toBe(manifest.version!);
  });

  test("is a plain x.y.z triple", () => {
    expect(MIN_CLAUDE_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
