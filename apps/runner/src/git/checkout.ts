/**
 * The checkout gate (M4): the only place the runner moves a workspace's
 * HEAD, on behalf of a dispatch that named a branch.
 *
 * The order is the safety policy, and each step is a refusal, never a
 * repair: a malformed name never reaches git (argv safety even though argv
 * arrays never interpolate); a dirty tracked tree is the operator's to
 * resolve — the runner never cleans, stashes, or resets (§15.5); the branch
 * must be proven to be a local head before checkout, because bare
 * `rev-parse <name>` accepts tags and `origin/*`, and checking out either
 * detaches HEAD or DWIM-creates a local branch — both outside M4. A failed
 * or timed-out checkout (the spawner bounds it) refuses without retry.
 */

import type { PrepareWorkspaceResult } from "../execution/executor.ts";
import type { GitSpawn } from "./spawn.ts";

/** Mirrors the dispatch route's validation: argv-safe, git-plausible. */
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_BRANCH_NAME = 256;

/**
 * Prepare `cwd` for a run that named `branch`. `undefined` means the
 * dispatch named none: nothing runs and the workspace stays as it is.
 */
export async function prepareBranch(
  cwd: string,
  branch: string | undefined,
  spawn: GitSpawn,
): Promise<PrepareWorkspaceResult> {
  if (branch === undefined) return { kind: "ready", checkedOut: false };

  if (branch.length > MAX_BRANCH_NAME || !BRANCH_NAME.test(branch) || branch.includes("..")) {
    return { kind: "refused", reason: "invalid_branch_name", branch };
  }

  // Dirty = any porcelain line that is not untracked (`?? `). Untracked
  // files survive a checkout untouched and are not the runner's to judge.
  // A non-zero exit is git itself refusing (a non-repo, a broken object
  // store) — not dirt, and not runnable.
  const status = await spawn(["git", "status", "--porcelain"], cwd);
  if (status.exitCode !== 0) {
    return { kind: "refused", reason: "checkout_failed", branch };
  }
  const dirty = status.stdout
    .split("\n")
    .some((line) => line !== "" && !line.startsWith("?? "));
  if (dirty) return { kind: "refused", reason: "dirty_tree", branch };

  // Fully qualified on purpose: only a ref under refs/heads/ is a branch
  // this gate will check out (see the module comment).
  const verify = await spawn(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
  if (verify.exitCode !== 0) {
    return { kind: "refused", reason: "unknown_branch", branch };
  }

  const checkout = await spawn(["git", "checkout", branch], cwd);
  if (checkout.exitCode !== 0) {
    return { kind: "refused", reason: "checkout_failed", branch };
  }

  return { kind: "ready", checkedOut: true, branch };
}
