#!/usr/bin/env bun
/**
 * Smoke: the compiled single-file runner binary (§6.2).
 *
 * `bun build --compile` turns the runner into one executable that carries the
 * Bun runtime inside it, so a host needs no Bun installed to run a connector.
 * This probe builds the binary exactly as `build:runner` does and asserts the
 * behaviors that only hold for, or matter most for, the compiled artifact:
 *
 *   1. `service print` emits a systemd unit whose ExecStart is the binary
 *      itself with the connect subcommand — no `.ts` script path, no `bun`
 *      prefix, since there is no runtime to invoke separately
 *   2. an unknown command is refused with a non-zero exit (the USAGE gate)
 *   3. `setup` writes a 0600 identity from the CC_WEB_RUNNER_TOKEN env path
 *
 * Docker mode is a notice, not a run: this probe compiles on the host and runs
 * the artifact on the host, and containerizing that adds nothing the probe
 * could observe.
 *
 *   bun run scripts/integration/runner-binary.ts
 */

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}: ${detail}`);
}

const useDocker = process.argv.includes("--docker");
if (useDocker) {
  console.log(
    "mode: docker requested but this probe compiles and runs on the host; running host-local",
  );
}

const repoRoot = new URL("../..", import.meta.url).pathname;
const binary = join(repoRoot, "dist", "cc-web-runner");

console.log("building dist/cc-web-runner (bun build --compile)…");
const build = Bun.spawnSync(
  ["bun", "build", "--compile", "apps/runner/src/bootstrap/main.ts", "--outfile", binary],
  {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  },
);
check(
  "the runner compiles to a single executable",
  build.exitCode === 0,
  new TextDecoder().decode(build.stderr).slice(0, 300) || `built ${binary}`,
);

if (build.exitCode === 0) {
  const printed = Bun.spawnSync([binary, "service", "print"], { stdout: "pipe", stderr: "pipe" });
  const unit = new TextDecoder().decode(printed.stdout);
  const execStart = unit.split("\n").find((line) => line.startsWith("ExecStart=")) ?? "";
  check(
    "service print emits a systemd unit whose ExecStart is the binary itself",
    printed.exitCode === 0 &&
      unit.includes("[Unit]") &&
      execStart.startsWith(`ExecStart=${binary}`) &&
      execStart.endsWith(" connect"),
    execStart,
  );
  check(
    "the unit carries no script path and locates the identity by CC_WEB_RUNNER_HOME",
    !unit.includes(".ts") &&
      unit.includes("Environment=CC_WEB_RUNNER_HOME=") &&
      unit.includes("Restart=on-failure"),
    unit
      .split("\n")
      .filter((l) => l.startsWith("Environment=") || l.startsWith("Restart="))
      .join(" | "),
  );

  const unknown = Bun.spawnSync([binary, "frobnicate"], { stdout: "pipe", stderr: "pipe" });
  check(
    "an unknown command exits non-zero with usage",
    unknown.exitCode !== 0 && new TextDecoder().decode(unknown.stderr).includes("unknown command"),
    `exit=${unknown.exitCode}`,
  );

  const home = await mkdtemp(join(tmpdir(), "cc-web-binary-"));
  try {
    const runnerId = "7b3a0f1e-1111-4222-8333-444455556666";
    const setup = Bun.spawnSync(
      [binary, "setup", "--server", "http://localhost:8787", "--runner-id", runnerId],
      {
        env: {
          ...process.env,
          CC_WEB_RUNNER_HOME: home,
          CC_WEB_RUNNER_TOKEN: "binary-smoke-token",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const raw = await readFile(join(home, "identity.json"), "utf8");
    const identity = JSON.parse(raw) as Record<string, string>;
    const mode = (await stat(join(home, "identity.json"))).mode & 0o777;
    check(
      "setup from the binary writes the token into a 0600 identity",
      setup.exitCode === 0 &&
        identity["runnerId"] === runnerId &&
        identity["credential"] === "binary-smoke-token" &&
        identity["controlUrl"] === "ws://localhost:8787/ws/runner" &&
        mode === 0o600,
      `exit=${setup.exitCode} mode=${mode.toString(8)}`,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }

  // The release workflow bakes a server origin in at compile time; a binary
  // built that way must accept setup without --server. Bun's --define only
  // matches this bare identifier, so this also guards the define wiring.
  const bakedBinary = join(repoRoot, "dist", "cc-web-runner-baked");
  const bakedBuild = Bun.spawnSync(
    [
      "bun",
      "build",
      "--compile",
      "--define",
      'CC_WEB_DEFAULT_SERVER:"https://cc-baked.example.com"',
      "apps/runner/src/bootstrap/main.ts",
      "--outfile",
      bakedBinary,
    ],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
  );
  if (bakedBuild.exitCode === 0) {
    const bakedHome = await mkdtemp(join(tmpdir(), "cc-web-baked-"));
    try {
      const setup = Bun.spawnSync([bakedBinary, "setup", "--runner-id", "baked-runner"], {
        env: {
          ...process.env,
          CC_WEB_RUNNER_HOME: bakedHome,
          CC_WEB_RUNNER_TOKEN: "baked-smoke-token",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const raw = await readFile(join(bakedHome, "identity.json"), "utf8");
      const identity = JSON.parse(raw) as Record<string, string>;
      check(
        "a binary with a baked default accepts setup without --server",
        setup.exitCode === 0 && identity["controlUrl"] === "wss://cc-baked.example.com/ws/runner",
        `exit=${setup.exitCode} controlUrl=${identity["controlUrl"] ?? "(none)"}`,
      );
    } finally {
      await rm(bakedHome, { recursive: true, force: true });
      await rm(bakedBinary, { force: true });
    }
  } else {
    check("the baked-default binary compiles", false, "bun build --define failed");
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
