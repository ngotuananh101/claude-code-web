import { describe, expect, test } from "bun:test";
import { parseArgs } from "./build-runner.ts";

describe("parseArgs", () => {
  test("defaults are host and the stock outfile", () => {
    expect(parseArgs([])).toEqual({
      target: "host",
      outfile: "dist/cc-web-runner",
      defines: [],
      variant: "slim",
    });
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
      variant: "slim",
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
      variant: "slim",
    });
    expect(parseArgs(['--define=CC_WEB_DEFAULT_SERVER:"https://x.example"'])).toEqual({
      target: "host",
      outfile: "dist/cc-web-runner",
      defines: ['CC_WEB_DEFAULT_SERVER:"https://x.example"'],
      variant: "slim",
    });
  });

  test("an unknown flag is refused", () => {
    expect(() => parseArgs(["--frobnicate"])).toThrow();
  });
});

describe("variant selection", () => {
  test("slim is the default build", () => {
    expect(parseArgs([]).variant).toBe("slim");
  });

  test("--with-cli asks for the bundled build", () => {
    expect(parseArgs(["--with-cli"]).variant).toBe("bundled");
  });

  test("--with-cli combines with the release workflow's flags", () => {
    expect(
      parseArgs(["--target=bun-windows-x64", "--outfile", "dist/w.exe", "--with-cli"]),
    ).toEqual({
      target: "bun-windows-x64",
      outfile: "dist/w.exe",
      defines: [],
      variant: "bundled",
    });
  });
});
