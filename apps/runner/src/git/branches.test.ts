import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listBranches, parseBranchLines } from "./branches.ts";

/**
 * The declaration half of M4: the branches a workspace offers are its local
 * heads, listed by the runner itself. Real git against a temp repo, because
 * the interesting failures (non-repo, git missing) only exist against the
 * real binary.
 */
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-web-branches-"));
  dirs.push(dir);
  return dir;
}

function run(argv: string[], cwd: string): void {
  const proc = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${argv.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

function repoWithDevBranch(): string {
  const dir = tempDir();
  run(["git", "init", "-b", "main"], dir);
  run(["git", "config", "user.email", "test@cc-web"], dir);
  run(["git", "config", "user.name", "cc-web test"], dir);
  writeFileSync(join(dir, "file.txt"), "one\n");
  run(["git", "add", "."], dir);
  run(["git", "commit", "-m", "init"], dir);
  run(["git", "branch", "dev"], dir);
  return dir;
}

describe("listBranches", () => {
  test("lists the local heads of a repository", () => {
    const branches = listBranches(repoWithDevBranch());
    expect(branches).toContain("main");
    expect(branches).toContain("dev");
  });

  test("a directory that is not a repository lists no branches", () => {
    expect(listBranches(tempDir())).toEqual([]);
  });
});

describe("parseBranchLines", () => {
  test("drops empty lines and keeps order", () => {
    expect(parseBranchLines(["dev", "", "main", ""])).toEqual(["dev", "main"]);
  });

  test("keeps the first 200 entries", () => {
    const lines = Array.from({ length: 250 }, (_, i) => `b-${i}`);
    const parsed = parseBranchLines(lines);
    expect(parsed).toHaveLength(200);
    expect(parsed[0]).toBe("b-0");
    expect(parsed[199]).toBe("b-199");
  });

  test("drops entries longer than 256 characters", () => {
    expect(parseBranchLines(["ok", "x".repeat(257)])).toEqual(["ok"]);
  });

  test("keeps the first occurrence of a duplicate", () => {
    expect(parseBranchLines(["a", "b", "a"])).toEqual(["a", "b"]);
  });
});
