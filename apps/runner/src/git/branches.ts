/**
 * Listing the branches a workspace offers (M4, §15.1).
 *
 * "Branch" means a local head (`refs/heads/`) — the design pins it: tags and
 * remote-tracking refs are not check-out-able without detaching or creating,
 * both owner-level decisions. The list is built where the hello/reconcile
 * frames are, so it is synchronous on purpose: it runs once per dial, not in
 * the run path.
 *
 * Failure declares nothing: a workspace that is not a repository (or a
 * machine without git) is a workspace with no branches to offer, not a
 * runner that cannot boot.
 */

import { parseBranchLines } from "./parse.ts";

export { parseBranchLines } from "./parse.ts";

/**
 * Run one git command, translating every failure into "git could not answer".
 *
 * `Bun.spawnSync` *throws* rather than returning a non-zero exit when the cwd
 * does not exist — and the throw names the binary (`posix_spawn 'git'` with
 * ENOENT), which reads as "git is missing" when the truth is "the folder is".
 * Both are the same answer here. This is not hypothetical: hello() declares
 * every workspace on the host, so one persisted custom workspace whose folder
 * the operator has since deleted used to throw out of the dial and put the
 * daemon in a systemd restart loop.
 */
function gitResult(argv: string[], cwd: string): { exitCode: number; stdout: string } | undefined {
  try {
    const proc = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    return { exitCode: proc.exitCode, stdout: proc.stdout.toString() };
  } catch {
    return undefined;
  }
}

/**
 * The local heads of the repository at `path`, or `[]` when git cannot
 * answer. Bounded by spawnSync's timeout so a hung git cannot wedge the
 * dial.
 */
export function listBranches(path: string): string[] {
  const proc = gitResult(["git", "for-each-ref", "--format=%(refname:short)", "refs/heads"], path);
  if (proc === undefined || proc.exitCode !== 0) return [];
  return parseBranchLines(proc.stdout.split("\n"));
}

/** Git refnames cap far below this; mirrors the protocol's bound. */
const MAX_BRANCH_NAME = 256;

/**
 * The local head HEAD points at in the repository at `path`, shown to the
 * operator as read-only context. `undefined` when git cannot answer: not a
 * repository, git missing, a missing folder, or a detached HEAD (no branch to
 * name).
 */
export function currentBranch(path: string): string | undefined {
  const proc = gitResult(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], path);
  if (proc === undefined || proc.exitCode !== 0) return undefined;
  const name = proc.stdout.trim();
  if (name === "" || name.length > MAX_BRANCH_NAME) return undefined;
  return name;
}
