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

  test("an unknown flag is refused", () => {
    expect(() => parseArgs(["--frobnicate"])).toThrow();
  });
});
