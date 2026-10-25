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

  test("a missing binary is a failed result, not a throw", async () => {
    const result = await gitSpawn(["cc-web-definitely-not-a-binary", "x"], "/");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});
