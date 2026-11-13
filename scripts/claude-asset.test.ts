import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAssetTarget } from "../packages/agent-adapter/src/claude-asset-targets.ts";
import { generateShim, parseTargetArg } from "./claude-asset.ts";

// Every test generates into its own temp file: writing the real shim here would
// change the build variant every later test in the process imports.
async function withTempShim<T>(run: (outPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "cc-web-claude-asset-"));
  try {
    return await run(join(dir, "claude-asset.generated.ts"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("generateShim", () => {
  test("bundled shim names the host target's binary as a file asset", async () => {
    await withTempShim(async (outPath) => {
      const pending = generateShim("host", "bundled", outPath);
      expect(pending).toBeInstanceOf(Promise);
      await pending;
      const asset = claudeAssetTarget("host");
      const shim = readFileSync(outPath, "utf8");
      expect(shim).toContain(`import binPath from "${asset.pkg}/${asset.binary}"`);
      expect(shim).toContain('kind: "embedded"');
    });
  });

  test("slim shim imports no platform package at all", async () => {
    await withTempShim(async (outPath) => {
      await generateShim("host", "slim", outPath);
      const shim = readFileSync(outPath, "utf8");
      expect(shim).toContain('kind: "external"');
      // A single static import is enough to pull 293 MB into the executable.
      expect(shim).not.toContain("@anthropic-ai/claude-agent-sdk-");
      expect(shim).not.toContain('with { type: "file" }');
    });
  });

  test("the variant defaults to bundled", async () => {
    await withTempShim(async (outPath) => {
      // undefined keeps the variant argument at its default.
      await generateShim("host", undefined, outPath);
      expect(readFileSync(outPath, "utf8")).toContain('kind: "embedded"');
    });
  });
});

describe("parseTargetArg", () => {
  test("no flag means the host target", () => {
    expect(parseTargetArg([])).toBe("host");
  });

  test("both spellings of the flag are read", () => {
    expect(parseTargetArg(["--target", "bun-windows-x64"])).toBe("bun-windows-x64");
    expect(parseTargetArg(["--target=bun-windows-x64"])).toBe("bun-windows-x64");
  });

  test("a missing value is refused rather than defaulting to host", () => {
    // `--target --foo` used to take "--foo" as the target and throw from the
    // target map; an empty value used to fall back to host and embed the WRONG
    // platform's binary into a cross-compiled release artifact.
    expect(() => parseTargetArg(["--target="])).toThrow("requires a value");
    expect(() => parseTargetArg(["--target"])).toThrow("requires a value");
    expect(() => parseTargetArg(["--target", "--foo"])).toThrow("requires a value");
  });

  test("an unknown flag is refused instead of silently writing the host shim", () => {
    // A typo ("--targt=…") was ignored and the host shim rewritten: the run
    // reported success while naming the wrong platform.
    expect(() => parseTargetArg(["--targt=bun-windows-x64"])).toThrow("unknown claude-asset flag");
    expect(() => parseTargetArg(["-t", "bun-windows-x64"])).toThrow("unknown claude-asset flag");
    expect(() => parseTargetArg(["--target", "bun-windows-x64", "--with-cli"])).toThrow(
      "unknown claude-asset flag",
    );
    expect(() => parseTargetArg(["bun-windows-x64"])).toThrow("unknown claude-asset flag");
  });
});
