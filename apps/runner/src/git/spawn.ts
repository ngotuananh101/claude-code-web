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

export async function gitSpawn(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<GitResult> {
  try {
    const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    try {
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      return { exitCode, stdout };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // A missing binary or a spawn failure is the caller's "git refused"
    // answer, not a crash of the run loop.
    return { exitCode: 1, stdout: "" };
  }
}
