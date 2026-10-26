import { describe, expect, test } from "bun:test";
import { gitSpawn } from "./spawn.ts";

/**
 * The bounded process spawner behind the checkout gate (§15.2): argv arrays
 * only, a hard timeout, and failures as results — never throws. These tests
 * run real processes; the gate's decision logic is tested against a fake.
 */
describe("gitSpawn", () => {
  test("runs a command and reports exit code and stdout", async () => {
    const result = await gitSpawn(["git", "--version"], "/");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("git version");
  });

  test("a process past its timeout is killed and reports failure", async () => {
    const startedAt = Date.now();
    const result = await gitSpawn(["sleep", "5"], "/", 100);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  test("a process that ignores SIGTERM still returns at the timeout", async () => {
    // The hazard this pins: the caller awaits this call holding the workspace
    // lock (§11.4). If the timeout only *asked* the process to die — a git
    // blocked on an uninterruptible filesystem never gets the signal at all —
    // the await would hang for as long as the process lives, and the lock with
    // it. The refusal must be a result the runner can act on, not a wait.
    const startedAt = Date.now();
    // `trap '' TERM` makes the signal a no-op, so only the SIGKILL escalation
    // can end this — and even without it, the call must already have returned.
    const result = await gitSpawn(["bash", "-c", "trap '' TERM; sleep 30"], "/", 200);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  test("a timed-out process leaves nothing behind", async () => {
    // A survivor would hold the workspace directory open and keep running the
    // command the runner already refused.
    const marker = `/tmp/cc-web-spawn-survivor-${Date.now()}`;
    await gitSpawn(["bash", "-c", `trap '' TERM; sleep 1; touch ${marker}`], "/", 200);
    // Past when the un-killed process would have touched it; the 1s sleep
    // outlives the 200ms timeout plus the kill grace.
    await Bun.sleep(900);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("a missing binary is a failed result, not a throw", async () => {
    const result = await gitSpawn(["cc-web-definitely-not-a-binary", "x"], "/");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});
