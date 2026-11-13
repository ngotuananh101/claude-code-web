import { describe, expect, test } from "bun:test";
import { type BuildArgs, parseArgs, runBuild } from "./build-runner.ts";

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

  test("the flag takes no value, so an equals form is rejected", () => {
    // A boolean flag must never reach the value-parsing path: before this was
    // pinned, --with-cli=true silently overwrote `outfile` with "true".
    expect(() => parseArgs(["--with-cli=true"])).toThrow("unknown build:runner flag");
  });

  test("a flag with no value does not swallow the next flag", () => {
    // `--outfile --with-cli` used to take "--with-cli" as the outfile and leave
    // the variant at slim: a silent wrong-variant build into a file named
    // `--with-cli`.
    expect(() => parseArgs(["--outfile", "--with-cli"])).toThrow("requires a non-empty value");
    expect(() => parseArgs(["--outfile"])).toThrow("requires a non-empty value");
    expect(() => parseArgs(["--outfile="])).toThrow("requires a non-empty value");
    expect(() => parseArgs(["--target="])).toThrow("requires a non-empty value");
  });
});

describe("runBuild", () => {
  const args: BuildArgs = {
    target: "bun-windows-x64",
    outfile: "dist/w.exe",
    defines: [],
    variant: "slim",
  };
  const PREVIOUS = "// the shim that was here before the build\n";

  function deps(overrides: Partial<Parameters<typeof runBuild>[1]>) {
    const shims: string[] = [];
    const written: string[] = [];
    const errors: string[] = [];
    return {
      shims,
      written,
      errors,
      deps: {
        compile: () => ({ exitCode: 0 }),
        readShim: async () => PREVIOUS,
        writeShimFile: async (text: string) => {
          written.push(text);
        },
        writeShim: async (target: string) => {
          shims.push(target);
        },
        error: (line: string) => {
          errors.push(line);
        },
        ...overrides,
      },
    };
  }

  test("writes the target's shim first, then puts the previous one back", async () => {
    const d = deps({});
    expect(await runBuild(args, d.deps)).toBe(0);
    expect(d.shims).toEqual(["bun-windows-x64"]);
    expect(d.written).toEqual([PREVIOUS]);
  });

  test("a failed compile keeps its own exit code", async () => {
    const d = deps({ compile: () => ({ exitCode: 2 }) });
    expect(await runBuild(args, d.deps)).toBe(2);
    expect(d.written).toEqual([PREVIOUS]);
  });

  test("the restore is the previous text, so a darwin host needs no target mapping", async () => {
    // darwin is absent from the target map: regenerating "host, bundled" threw
    // after a successful slim compile and turned exit 0 into exit 1. Writing
    // the captured text back never consults the map.
    let consulted = false;
    const d = deps({
      writeShim: async (target: string) => {
        d.shims.push(target);
        if (target === "host") consulted = true;
      },
    });
    expect(await runBuild(args, d.deps)).toBe(0);
    expect(consulted).toBe(false);
    expect(d.written).toEqual([PREVIOUS]);
  });

  test("a restore that throws does not replace the compile's exit code", async () => {
    const d = deps({
      compile: () => ({ exitCode: 2 }),
      writeShimFile: async () => {
        throw new Error("ENOSPC");
      },
    });
    expect(await runBuild(args, d.deps)).toBe(2);
    expect(d.errors.join("\n")).toContain("could not restore the shim");
  });

  test("a restore failure on a clean build does not report success", async () => {
    // The compile succeeded, but the shim was left naming another target: the
    // next `bun test` in this checkout would import the wrong package.
    const d = deps({
      writeShimFile: async () => {
        throw new Error("ENOSPC");
      },
    });
    expect(await runBuild(args, d.deps)).toBe(1);
    expect(d.errors.length).toBe(2);
    expect(d.errors[0]).toContain("could not restore the shim");
  });

  test("a target shim that cannot be written refuses before compiling", async () => {
    let compiled = false;
    const d = deps({
      compile: () => {
        compiled = true;
        return { exitCode: 0 };
      },
      writeShim: async (target: string) => {
        d.shims.push(target);
        if (target !== "host") throw new Error("no platform package is mapped for target x");
      },
    });
    await expect(runBuild(args, d.deps)).rejects.toThrow("no platform package is mapped");
    expect(compiled).toBe(false);
    expect(d.shims).toEqual(["bun-windows-x64"]);
    expect(d.written).toEqual([]);
  });
});
