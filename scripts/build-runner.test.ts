import { describe, expect, test } from "bun:test";
import { parseArgs } from "./build-runner.ts";

describe("parseArgs", () => {
  test("defaults are host and the stock outfile", () => {
    expect(parseArgs([])).toEqual({ target: "host", outfile: "dist/cc-web-runner", defines: [] });
  });

  test("target, outfile and defines parse in any order", () => {
    expect(
      parseArgs([
        "--target",
        "bun-windows-x64",
        "--outfile",
        "dist/w.exe",
        "--define",
        'CC_WEB_DEFAULT_SERVER:"https://x.example"',
      ]),
    ).toEqual({
      target: "bun-windows-x64",
      outfile: "dist/w.exe",
      defines: ['CC_WEB_DEFAULT_SERVER:"https://x.example"'],
    });
  });

  test("the release workflow's equals-form flags parse", () => {
    // .github/workflows/runner-build.yml builds args=(--target="..." --outfile ...)
    // — one bash word per flag — so the equals form is the release contract.
    expect(
      parseArgs(["--target=bun-linux-arm64", "--outfile", "dist/cc-web-runner-bun-linux-arm64"]),
    ).toEqual({
      target: "bun-linux-arm64",
      outfile: "dist/cc-web-runner-bun-linux-arm64",
      defines: [],
    });
    expect(parseArgs(['--define=CC_WEB_DEFAULT_SERVER:"https://x.example"'])).toEqual({
      target: "host",
      outfile: "dist/cc-web-runner",
      defines: ['CC_WEB_DEFAULT_SERVER:"https://x.example"'],
    });
  });

  test("an unknown flag is refused", () => {
    expect(() => parseArgs(["--frobnicate"])).toThrow();
  });
});
