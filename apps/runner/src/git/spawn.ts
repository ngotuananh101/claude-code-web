/**
 * The bounded process spawner behind the git surfaces (§15.2).
 *
 * Every git call goes through here so the rules hold in one place: argv
 * arrays with an explicit cwd — no shell, no interpolated strings — and a
 * hard timeout, because a wedged `git` must never hold a run (and the
 * workspace lock) forever. Failure is a result, never a throw: callers
 * translate non-zero exits into their own refusals.
 */

export type GitResult = { exitCode: number; stdout: string };

/**
 * The spawner seam the checkout gate runs against. Production is
 * {@link gitSpawn}; tests script one per call to pin decision logic (and
 * the exact argv arrays) without a repository.
 */
export type GitSpawn = (argv: readonly string[], cwd: string) => Promise<GitResult>;

/** How long any single git invocation may run before it is killed. */
export const GIT_TIMEOUT_MS = 10_000;

/** How long a SIGTERM gets to land before the group is killed outright. */
const GIT_KILL_GRACE_MS = 500;

/** The result of a git invocation killed for hanging: a refusal, not a throw. */
const TIMED_OUT: GitResult = { exitCode: 1, stdout: "" };

export async function gitSpawn(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<GitResult> {
  try {
    // The copy is for Bun.spawn's mutable-argv typing; the array is never
    // mutated, and callers keep the readonly contract.
    //
    // `detached` is what makes the timeout enforceable. Without it the child
    // stays in the runner's own process group, and a group-wide signal would
    // take the runner down with the git it meant to kill. It also gets the
    // child its own group to signal: a shell that has already forked its real
    // work leaves a grandchild the pid-only kill below cannot reach.
    const proc = Bun.spawn([...argv], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    // The reader is attached before the timeout is armed: a process that never
    // exits is never awaited again, and its pipe must already be draining so
    // the abandoned child cannot block writing into a full buffer.
    const stdout = new Response(proc.stdout).text();
    let termTimer: ReturnType<typeof setTimeout> | undefined;

    // Timing out is a *result*, not a promise that waits for the process to
    // die. The executor awaits this call while holding the workspace lock, so
    // a process that ignores SIGTERM — a git stuck on an uninterruptible
    // filesystem — would hold that lock for the life of the runner, and every
    // later attempt on the workspace would be refused `workspace_locked`
    // until a restart. The SIGKILL escalation is therefore armed here, and the
    // refusal does not depend on either signal succeeding.
    const timedOut = new Promise<GitResult>((resolve) => {
      termTimer = setTimeout(() => {
        // The group first, the pid as a belt-and-braces both runtimes accept
        // (`detached` makes the child its own group leader, so the two are the
        // same process here; the group also covers anything it forked).
        try {
          process.kill(-proc.pid, "SIGTERM");
        } catch {
          proc.kill();
        }
        setTimeout(() => {
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch {
            proc.kill("SIGKILL");
          }
        }, GIT_KILL_GRACE_MS);
        resolve(TIMED_OUT);
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        (async (): Promise<GitResult> => ({
          exitCode: await proc.exited,
          stdout: await stdout,
        }))(),
        timedOut,
      ]);
    } finally {
      // Only the SIGTERM timer is disarmed here. The SIGKILL one is what
      // actually ends the process: SIGTERM is routinely ignored exactly by the
      // hangs this timeout exists for, so cancelling the escalation on the way
      // out would leave the child alive while its buffer keeps filling — the
      // lock would be free but the workspace would still be in use. It fires
      // on its own, at most one grace period late, and by then the pid can
      // only be that process's own group.
      clearTimeout(termTimer);
    }
  } catch {
    // A missing binary or a spawn failure is the caller's "git refused"
    // answer, not a crash of the run loop.
    return { exitCode: 1, stdout: "" };
  }
}
