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
 * The local heads of the repository at `path`, or `[]` when git cannot
 * answer. Bounded by spawnSync's timeout so a hung git cannot wedge the
 * dial.
 */
export function listBranches(path: string): string[] {
  const proc = Bun.spawnSync(["git", "for-each-ref", "--format=%(refname:short)", "refs/heads"], {
    cwd: path,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  if (proc.exitCode !== 0) return [];
  return parseBranchLines(proc.stdout.toString().split("\n"));
}

/** Git refnames cap far below this; mirrors the protocol's bound. */
const MAX_BRANCH_NAME = 256;

/**
 * The local head HEAD points at in the repository at `path`, shown to the
 * operator as read-only context. `undefined` when git cannot answer: not a
 * repository, git missing, or a detached HEAD (no branch to name).
 */
export function currentBranch(path: string): string | undefined {
  const proc = Bun.spawnSync(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: path,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  if (proc.exitCode !== 0) return undefined;
  const name = proc.stdout.toString().trim();
  if (name === "" || name.length > MAX_BRANCH_NAME) return undefined;
  return name;
}
