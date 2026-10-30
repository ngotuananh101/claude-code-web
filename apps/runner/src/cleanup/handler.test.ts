import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, utimesSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanOrphanedTemp, cleanSessionTemp, createCleanupHandler } from "./handler.ts";

/**
 * Temp-directory cleanup for finished sessions (§session-cleanup).
 *
 * `cleanSessionTemp` removes one session's attachment directory; `cleanOrphanedTemp`
 * sweeps the sessions directory and reaps subdirectories older than a max age.
 * Both sanitize their `sessionId` argument with `path.basename` so a traversal
 * like `../` cannot escape `${runnerHome}/tmp/sessions/`.
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function freshDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("cleanSessionTemp", () => {
  test("removes the session temp directory recursively", async () => {
    const runnerHome = await freshDir("cc-web-clean-sess-");
    const target = join(runnerHome, "tmp/sessions/sess-1/attachments/sub");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "inside.txt"), "data");

    await cleanSessionTemp(runnerHome, "sess-1");

    expect(existsSync(target)).toBe(false);
  });

  test("is a no-op when the session directory does not exist", async () => {
    const runnerHome = await freshDir("cc-web-clean-sess-");

    // Should not throw even though nothing exists.
    await expect(cleanSessionTemp(runnerHome, "no-such-session")).resolves.toBeUndefined();
  });

  test("sanitizes sessionId to prevent path traversal", async () => {
    const runnerHome = await freshDir("cc-web-clean-sess-");

    // A traversal attempt: only the basename "evil" is used, so it must operate
    // inside tmp/sessions/evil, not escape runnerHome.
    await mkdir(join(runnerHome, "tmp/sessions/evil"), { recursive: true });
    await writeFile(join(runnerHome, "tmp/sessions/evil", "keep.txt"), "keep");

    // A directory outside the sessions dir that a traversal would hit.
    await mkdir(join(runnerHome, "tmp/evil"), { recursive: true });
    await writeFile(join(runnerHome, "tmp/evil", "outside.txt"), "outside");

    await cleanSessionTemp(runnerHome, "../evil");

    // The traversal target (tmp/sessions/evil) was removed.
    expect(existsSync(join(runnerHome, "tmp/sessions/evil"))).toBe(false);
    // The directory outside the sessions dir is untouched.
    expect(existsSync(join(runnerHome, "tmp/evil"))).toBe(true);
  });

  test("sanitizes an absolute path sessionId to its basename", async () => {
    const runnerHome = await freshDir("cc-web-clean-sess-");

    // An absolute path: path.basename strips it to the last segment.
    const basename = "sess-abs";
    await mkdir(join(runnerHome, "tmp/sessions", basename), { recursive: true });
    await writeFile(join(runnerHome, "tmp/sessions", basename, "x.txt"), "x");

    await cleanSessionTemp(runnerHome, `/some/abs/path/${basename}`);

    expect(existsSync(join(runnerHome, "tmp/sessions", basename))).toBe(false);
  });
});

describe("cleanOrphanedTemp", () => {
  test("removes directories older than maxAgeMs and returns the count", async () => {
    const runnerHome = await freshDir("cc-web-clean-orphan-");
    const sessDir = join(runnerHome, "tmp/sessions");
    await mkdir(join(sessDir, "old-1"), { recursive: true });
    await mkdir(join(sessDir, "old-2"), { recursive: true });
    await mkdir(join(sessDir, "fresh-1"), { recursive: true });

    // Backdate the "old" directories by setting their mtime far in the past.
    const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
    utimesSync(join(sessDir, "old-1"), oldTime / 1000, oldTime / 1000);
    utimesSync(join(sessDir, "old-2"), oldTime / 1000, oldTime / 1000);

    const removed = await cleanOrphanedTemp(runnerHome, 7 * 24 * 60 * 60 * 1000);

    expect(removed).toBe(2);
    expect(existsSync(join(sessDir, "old-1"))).toBe(false);
    expect(existsSync(join(sessDir, "old-2"))).toBe(false);
    expect(existsSync(join(sessDir, "fresh-1"))).toBe(true);
  });

  test("returns 0 when no session directories exist", async () => {
    const runnerHome = await freshDir("cc-web-clean-orphan-");

    const removed = await cleanOrphanedTemp(runnerHome);

    expect(removed).toBe(0);
  });

  test("leaves fresh directories alone", async () => {
    const runnerHome = await freshDir("cc-web-clean-orphan-");
    const sessDir = join(runnerHome, "tmp/sessions");
    await mkdir(join(sessDir, "fresh-1"), { recursive: true });

    const removed = await cleanOrphanedTemp(runnerHome, 7 * 24 * 60 * 60 * 1000);

    expect(removed).toBe(0);
    expect(existsSync(join(sessDir, "fresh-1"))).toBe(true);
  });

  test("ignores the default 7-day threshold when a custom maxAgeMs is given", async () => {
    const runnerHome = await freshDir("cc-web-clean-orphan-");
    const sessDir = join(runnerHome, "tmp/sessions");
    await mkdir(join(sessDir, "stale"), { recursive: true });

    // 1 hour old — fresh under the 7-day default but stale under a 60s cap.
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    utimesSync(join(sessDir, "stale"), oneHourAgo / 1000, oneHourAgo / 1000);

    const removed = await cleanOrphanedTemp(runnerHome, 60_000);
    expect(removed).toBe(1);
    expect(existsSync(join(sessDir, "stale"))).toBe(false);
  });
});

describe("createCleanupHandler", () => {
  test("answers a session.cleanup command with ok true after removing temp", async () => {
    const runnerHome = await freshDir("cc-web-clean-handler-");
    const sessDir = join(runnerHome, "tmp/sessions/sess-hello");
    await mkdir(sessDir, { recursive: true });
    await writeFile(join(sessDir, "file.txt"), "data");

    const handler = createCleanupHandler({ runnerHome });

    const frame = await handler({
      commandId: "cmd-clean-1",
      kind: "session.cleanup",
      issuedAt: "2026-10-30T00:00:00.000Z",
      runnerId: "runner-a",
      protocolVersion: 1,
      payload: { sessionId: "sess-hello" },
    });

    expect(frame).toEqual({
      type: "rpc.result",
      commandId: "cmd-clean-1",
      ok: true,
      result: { ok: true },
    });
    expect(existsSync(join(runnerHome, "tmp/sessions/sess-hello"))).toBe(false);
  });

  test("refuses a non-session.cleanup kind", async () => {
    const runnerHome = await freshDir("cc-web-clean-handler-");
    const handler = createCleanupHandler({ runnerHome });

    const frame = await handler({
      commandId: "cmd-x",
      kind: "workspace.inspect",
      issuedAt: "2026-10-30T00:00:00.000Z",
      runnerId: "runner-a",
      protocolVersion: 1,
    });

    expect(frame.ok).toBe(false);
    expect(frame.error?.code).toBe("UNSUPPORTED_COMMAND");
  });

  test("refuses a malformed payload", async () => {
    const runnerHome = await freshDir("cc-web-clean-handler-");
    const handler = createCleanupHandler({ runnerHome });

    const frame = await handler({
      commandId: "cmd-clean-2",
      kind: "session.cleanup",
      issuedAt: "2026-10-30T00:00:00.000Z",
      runnerId: "runner-a",
      protocolVersion: 1,
      payload: { wrong: "field" },
    });

    expect(frame.ok).toBe(false);
    expect(frame.error?.code).toBe("UNSUPPORTED_COMMAND");
  });

  test("returns ok false when cleanup throws", async () => {
    const runnerHome = await freshDir("cc-web-clean-handler-");
    const handler = createCleanupHandler({
      runnerHome,
      // Inject a cleanSessionTemp that throws to exercise the error path.
      cleanSessionTemp: async () => {
        throw new Error("disk on fire");
      },
    });

    const frame = await handler({
      commandId: "cmd-clean-3",
      kind: "session.cleanup",
      issuedAt: "2026-10-30T00:00:00.000Z",
      runnerId: "runner-a",
      protocolVersion: 1,
      payload: { sessionId: "sess-1" },
    });

    expect(frame.ok).toBe(false);
    expect(frame.error?.code).toBe("CLEANUP_FAILED");
    expect(frame.error?.message).toContain("disk on fire");
  });
});
