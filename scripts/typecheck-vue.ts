#!/usr/bin/env bun
/**
 * `typecheck:vue` — the SFC type gate.
 *
 * `tsc` never looks inside `.vue`, and two bugs of exactly that shape shipped
 * on 2026-11-01: a template that read `ref.value` (templates already unwrap
 * refs) and a save path copying a field `FileWriteResult` does not have.
 * `vue-tsgo` runs the repo's own TypeScript 7 (native, so it exposes no
 * compiler API that `vue-tsc` could drive) together with Volar's Vue language
 * core, which keeps this single-toolchain: no second TypeScript install.
 *
 * Diagnostics inside shadcn-vue's generated files are dropped, because those
 * files are never hand-edited (see CLAUDE.md) and a diagnostic there would
 * keep the gate permanently red. They are still counted and named on every
 * run, so the exclusion can never hide itself.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type Diagnostic = {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
};

/** Paths relative to `apps/web` whose diagnostics this gate does not own. */
const IGNORED_PREFIXES = ["src/components/ui/", "src/lib/utils.ts"];

// ANSI colour codes vue-tsgo emits on a TTY. Built from a char code because a
// control character inside a regex literal is lint-rejected.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const DIAGNOSTIC =
  /^(?<file>\S+?\.(?:vue|ts|tsx|mts|cts|js|jsx)):(?<line>\d+):(?<col>\d+) - error TS(?<code>\d+): (?<message>.*)$/;

/**
 * Split vue-tsgo's output into the diagnostics the gate enforces and the ones
 * it drops as generated-file noise. Summary lines ("Found N errors…",
 * "Errors Files") never match the diagnostic shape and are ignored.
 */
export function parseDiagnostics(output: string): {
  kept: Diagnostic[];
  ignored: Diagnostic[];
} {
  const kept: Diagnostic[] = [];
  const ignored: Diagnostic[] = [];
  for (const raw of output.replace(ANSI, "").split("\n")) {
    const groups = DIAGNOSTIC.exec(raw.trimEnd())?.groups;
    if (!groups) continue;
    const diagnostic: Diagnostic = {
      file: groups["file"] ?? "",
      line: Number(groups["line"]),
      col: Number(groups["col"]),
      code: groups["code"] ?? "",
      message: groups["message"] ?? "",
    };
    const generated = IGNORED_PREFIXES.some((prefix) => diagnostic.file.startsWith(prefix));
    (generated ? ignored : kept).push(diagnostic);
  }
  return { kept, ignored };
}

function main(): number {
  const repoRoot = join(import.meta.dir, "..");
  const webRoot = join(repoRoot, "apps", "web");
  const local = join(repoRoot, "node_modules", ".bin", "vue-tsgo");
  const command = existsSync(local) ? local : "vue-tsgo";

  const result = spawnSync(command, ["-p", "tsconfig.json"], {
    cwd: webRoot,
    encoding: "utf8",
  });
  if (result.error) {
    console.error(`typecheck:vue — cannot run vue-tsgo: ${result.error.message}`);
    return 1;
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const { kept, ignored } = parseDiagnostics(output);

  for (const d of kept) {
    console.error(`${d.file}:${d.line}:${d.col} TS${d.code}: ${d.message}`);
  }
  for (const d of ignored) {
    console.log(`ignored (generated) ${d.file}:${d.line}:${d.col} TS${d.code}`);
  }

  if (kept.length > 0) {
    console.error(
      `\ntypecheck:vue — ${kept.length} error(s) in ${new Set(kept.map((d) => d.file)).size} file(s).`,
    );
    return 1;
  }

  // No diagnostic we understand but a failing exit status means the compiler
  // itself failed (bad tsconfig, crash); surface its own output rather than
  // reporting a clean run.
  if (result.status !== 0 && ignored.length === 0) {
    console.error(output.trim() || `vue-tsgo exited with status ${String(result.status)}`);
    return 1;
  }

  console.log(`typecheck:vue — clean (${ignored.length} generated-file diagnostic(s) ignored).`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
