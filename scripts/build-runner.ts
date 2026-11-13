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
 *   bun run build:runner                                # slim, host target
 *   bun run build:runner --with-cli                     # bundled CLI
 *   bun run build:runner --with-cli --target bun-windows-x64 \
 *     --outfile dist/cc-web-runner-bundled-windows-x64.exe \
 *     --define 'CC_WEB_DEFAULT_SERVER:"https://cc.example.com"'
 */

import { generateShim } from "./claude-asset.ts";

const ENTRY = "apps/runner/src/bootstrap/main.ts";
const DEFAULT_OUTFILE = "dist/cc-web-runner";

export type BuildArgs = {
  target: string;
  outfile: string;
  defines: string[];
  variant: "slim" | "bundled";
};

export function parseArgs(argv: string[]): BuildArgs {
  const args: BuildArgs = {
    target: "host",
    outfile: DEFAULT_OUTFILE,
    defines: [],
    variant: "slim",
  };
  const known = ["--target", "--outfile", "--define"];
  for (let i = 0; i < argv.length; i++) {
    // Both `--flag value` and the workflow's `--flag=value` (one bash word) are
    // accepted, so the release contract cannot drift from local invocations.
    const token = argv[i] ?? "";
    if (token === "--with-cli") {
      args.variant = "bundled";
      continue;
    }
    const flag = known.find((f) => token === f || token.startsWith(`${f}=`));
    if (flag === undefined) throw new Error(`unknown build:runner flag: ${token}`);
    const inline = token === flag ? undefined : token.slice(flag.length + 1);
    // A bare flag followed by another flag (or nothing) has no value: taking
    // `argv[i + 1]` blindly swallows the next flag, so `--outfile --with-cli`
    // silently built SLIM into a file named `--with-cli`.
    const next = argv[i + 1];
    const value = inline ?? (next === undefined || next.startsWith("--") ? undefined : next);
    if (value === undefined || value.trim() === "") {
      throw new Error(`${flag} requires a non-empty value`);
    }
    if (flag === "--define") args.defines.push(value);
    else args[flag === "--target" ? "target" : "outfile"] = value;
    if (inline === undefined) i++;
  }
  return args;
}

type BuildDeps = {
  compile: (args: BuildArgs) => { exitCode: number | null };
  readShim: () => Promise<string>;
  writeShimFile: (text: string) => Promise<void>;
  writeShim: (target: string, variant: "slim" | "bundled") => Promise<void>;
  error: (line: string) => void;
};

const SHIM_FILE = new URL(
  "../packages/agent-adapter/src/claude-asset.generated.ts",
  import.meta.url,
).pathname;

function realDeps(): BuildDeps {
  return {
    compile: (args) =>
      Bun.spawnSync(
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
      ),
    readShim: () => Bun.file(SHIM_FILE).text(),
    writeShimFile: async (text) => {
      await Bun.write(SHIM_FILE, text);
    },
    writeShim: generateShim,
    error: (line) => console.error(line),
  };
}

/**
 * One build, then restore the shim that was on disk before it. Returns the exit
 * code the process should end with; deps are injectable so the restore paths
 * are tested without compiling anything.
 */
export async function runBuild(args: BuildArgs, deps: BuildDeps = realDeps()): Promise<number> {
  // Restoring the EXACT previous text, not "bundled for the host", matters on
  // two counts: a host absent from the target map (darwin) has no bundled shim
  // to restore — regenerating one throws — and a checkout deliberately left in
  // the slim shape must not be flipped back.
  const previous = await deps.readShim();
  // The shim must name the target's platform binary before the bundler reads
  // it — this is the whole point of the script. Outside the try: an unmapped
  // target throws before anything is written, so there is nothing to undo.
  await deps.writeShim(args.target, args.variant);

  let code = 1;
  let restored = true;
  try {
    code = deps.compile(args).exitCode ?? 1;
  } finally {
    // A failed restore (read-only checkout, ENOSPC) must not replace the
    // build's own result with a write error: it is reported, and the code
    // below decides what to return.
    try {
      await deps.writeShimFile(previous);
    } catch (error) {
      restored = false;
      deps.error(
        `warning: could not restore the shim: ${error instanceof Error ? error.message : String(error)}`,
      );
      deps.error("warning: run `bun run scripts/claude-asset.ts` before the next build or test.");
    }
  }
  // A compile that failed keeps its own code; a clean build that left the shim
  // altered did not do what this script promises, so it does not report success.
  return code !== 0 ? code : restored ? 0 : 1;
}

async function main(): Promise<void> {
  process.exitCode = await runBuild(parseArgs(process.argv.slice(2)));
}

if (import.meta.main) await main();
