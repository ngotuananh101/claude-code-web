import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrepareWorkspaceResult } from "../execution/executor.ts";
import { prepareBranch } from "./checkout.ts";
import { type GitSpawn, gitSpawn } from "./spawn.ts";

/**
 * The checkout gate (M4): the one place the runner moves a workspace's HEAD,
 * and only under conditions the design pins — clean tracked tree, branch
 * proven to be a local head, no force of any kind. Decision logic runs
 * against a scripted spawner (argv arrays are pinned there, §15.2); two
 * real-git tests anchor the decisions against actual git behavior.
 */

function fakeSpawn(script: Array<{ exitCode: number; stdout: string }>): {
  spawn: GitSpawn;
  calls: Array<{ argv: string[]; cwd: string }>;
} {
  const calls: Array<{ argv: string[]; cwd: string }> = [];
  const spawn: GitSpawn = async (argv, cwd) => {
    const step = script[calls.length];
    if (step === undefined) throw new Error(`unexpected spawn #${calls.length}: ${argv.join(" ")}`);
    calls.push({ argv: [...argv], cwd });
    return step;
  };
  return { spawn, calls };
}

const PORCELAIN_OK = { exitCode: 0, stdout: "" };

describe("prepareBranch — decisions", () => {
  test("no branch prepares nothing and spawns nothing", async () => {
    const { spawn, calls } = fakeSpawn([]);
    const result = await prepareBranch("/ws", undefined, spawn);
    expect(result).toEqual({ kind: "ready", checkedOut: false });
    expect(calls).toHaveLength(0);
  });

  test("a malformed branch name is refused before any git runs", async () => {
    for (const name of ["-x", "x".repeat(300), "a..b", "with space"]) {
      const { spawn, calls } = fakeSpawn([]);
      const result = await prepareBranch("/ws", name, spawn);
      expect(result).toEqual({ kind: "refused", reason: "invalid_branch_name", branch: name });
      expect(calls).toHaveLength(0);
    }
  });

  test("tracked changes refuse dirty_tree and stop before rev-parse", async () => {
    const { spawn, calls } = fakeSpawn([{ exitCode: 0, stdout: " M a.txt\n" }]);
    const result = await prepareBranch("/ws", "dev", spawn);
    expect(result).toEqual({ kind: "refused", reason: "dirty_tree", branch: "dev" });
    expect(calls).toHaveLength(1);
  });

  test("untracked-only output is not dirty; a clean switch checks out", async () => {
    const { spawn, calls } = fakeSpawn([
      { exitCode: 0, stdout: "?? new.txt\n" },
      { exitCode: 0, stdout: "abc123\n" },
      { exitCode: 0, stdout: "" },
    ]);
    const result = await prepareBranch("/ws", "dev", spawn);
    expect(result).toEqual({ kind: "ready", checkedOut: true, branch: "dev" });
    expect(calls).toHaveLength(3);
    // §15.2: argv arrays with the workspace as cwd; the branch rides as its
    // own argv element, never interpolated into a command string.
    expect(calls[0]).toEqual({ argv: ["git", "status", "--porcelain"], cwd: "/ws" });
    expect(calls[1]).toEqual({
      argv: ["git", "rev-parse", "--verify", "--quiet", "refs/heads/dev"],
      cwd: "/ws",
    });
    expect(calls[2]).toEqual({ argv: ["git", "checkout", "dev"], cwd: "/ws" });
  });

  test("git itself failing (a non-repo) refuses checkout_failed", async () => {
    const { spawn, calls } = fakeSpawn([{ exitCode: 128, stdout: "" }]);
    const result = await prepareBranch("/ws", "dev", spawn);
    expect(result).toEqual({ kind: "refused", reason: "checkout_failed", branch: "dev" });
    expect(calls).toHaveLength(1);
  });

  test("a branch with no local head refuses unknown_branch without checkout", async () => {
    const { spawn, calls } = fakeSpawn([PORCELAIN_OK, { exitCode: 1, stdout: "" }]);
    const result = await prepareBranch("/ws", "dev", spawn);
    expect(result).toEqual({ kind: "refused", reason: "unknown_branch", branch: "dev" });
    expect(calls).toHaveLength(2);
  });

  test("a failing checkout refuses checkout_failed", async () => {
    const { spawn, calls } = fakeSpawn([
      PORCELAIN_OK,
      { exitCode: 0, stdout: "abc\n" },
      { exitCode: 1, stdout: "" },
    ]);
    const result = await prepareBranch("/ws", "dev", spawn);
    expect(result).toEqual({ kind: "refused", reason: "checkout_failed", branch: "dev" });
    expect(calls).toHaveLength(3);
  });

  test("an already-checked-out branch is a ready result, not a refusal", async () => {
    const { spawn } = fakeSpawn([
      PORCELAIN_OK,
      { exitCode: 0, stdout: "abc\n" },
      { exitCode: 0, stdout: "" },
    ]);
    const result = await prepareBranch("/ws", "main", spawn);
    expect(result).toEqual({ kind: "ready", checkedOut: true, branch: "main" });
  });
});

// --- real git ---

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function repoOnMain(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-web-checkout-"));
  dirs.push(dir);
  const run = (argv: string[]) => {
    const proc = Bun.spawnSync(argv, { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`git ${argv.join(" ")}: ${proc.stderr.toString()}`);
  };
  run(["git", "init", "-b", "main"]);
  run(["git", "config", "user.email", "test@cc-web"]);
  run(["git", "config", "user.name", "cc-web test"]);
  writeFileSync(join(dir, "file.txt"), "one\n");
  run(["git", "add", "."]);
  run(["git", "commit", "-m", "init"]);
  run(["git", "branch", "dev"]);
  return dir;
}

function headOf(dir: string): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: dir,
    stdout: "pipe",
  });
  return proc.stdout.toString().trim();
}

describe("prepareBranch — real git", () => {
  test("a clean repository switches to the branch", async () => {
    const dir = repoOnMain();
    const result: PrepareWorkspaceResult = await prepareBranch(dir, "dev", gitSpawn);
    expect(result).toEqual({ kind: "ready", checkedOut: true, branch: "dev" });
    expect(headOf(dir)).toBe("dev");
  });

  test("a tracked modification refuses and leaves HEAD alone", async () => {
    const dir = repoOnMain();
    writeFileSync(join(dir, "file.txt"), "changed\n");
    const result = await prepareBranch(dir, "dev", gitSpawn);
    expect(result).toEqual({ kind: "refused", reason: "dirty_tree", branch: "dev" });
    expect(headOf(dir)).toBe("main");
  });
});
