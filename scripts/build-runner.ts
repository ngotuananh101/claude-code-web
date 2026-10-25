#!/usr/bin/env bun
/**
 * `build:runner` — the compiled runner binary, with the right CLI inside (§20.3).
 *
 * Wrapping `bun build --compile` in a script exists for one reason: the SDK's
 * native CLI must be EMBEDDED per target, and the asset specifier is static.
 * Before compiling, the asset shim is regenerated for the requested `--target`,
 * so a cross-compiled binary can never inherit the host's CLI — the failure
 * mode this guards is a windows artifact that carries a linux `claude` and
 * only dies on the runner host, at first use.
 *
 *   bun run build:runner                                # host target
 *   bun run build:runner --target bun-windows-x64 \
 *     --outfile dist/cc-web-runner-windows-x64.exe      \
 *     --define 'CC_WEB_DEFAULT_SERVER:"https://cc.example.com"'
 */

import { generateShim } from "./claude-asset.ts";

const ENTRY = "apps/runner/src/bootstrap/main.ts";
const DEFAULT_OUTFILE = "dist/cc-web-runner";

export type BuildArgs = { target: string; outfile: string; defines: string[] };

export function parseArgs(argv: string[]): BuildArgs {
  const args: BuildArgs = { target: "host", outfile: DEFAULT_OUTFILE, defines: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--target" || flag === "--outfile") {
      if (value === undefined) throw new Error(`${flag} requires a value`);
      args[flag === "--target" ? "target" : "outfile"] = value;
      i++;
    } else if (flag === "--define") {
      if (value === undefined) throw new Error("--define requires a name:value pair");
      args.defines.push(value);
      i++;
    } else {
      throw new Error(`unknown build:runner flag: ${flag}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // The shim must name the target's platform binary before the bundler reads
  // it — this is the whole point of the script.
  generateShim(args.target);

  const spawned = Bun.spawnSync(
    [
      "bun",
      "build",
      "--compile",
      ...(args.target === "host" ? [] : ["--target", args.target]),
      "--outfile",
      args.outfile,
      ...args.defines.flatMap((d) => ["--define", d]),
      ENTRY,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  process.exit(spawned.exitCode ?? 1);
}

if (import.meta.main) await main();
