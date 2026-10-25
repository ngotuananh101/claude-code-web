import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attemptState, lockHolder } from "@cc-web/runner-db";
import { helloFrame, type Daemon, startDaemon } from "./daemon.ts";
import type { SdkStream } from "./execution/executor.ts";
import { saveIdentity } from "./identity/identity-store.ts";

/**
 * The daemon composition, without a server or a model.
 *
 * The reconnect loop is the part that talks to the control server; everything
 * below it — identity, database, the run controller, shutdown — is what this
 * file exercises. The dial target is a closed port, so the loop's first attempt
 * fails and backs off, which is exactly the "control server is down" state a
 * runner has to survive.
 *
 * The property that prompted this test: `stop()` used to close the database
 * without waiting for runs that were still writing to it. It is now async, and
 * that is load-bearing, not cosmetic.
 */

const dirs: string[] = [];
const daemons: Daemon[] = [];

async function setup(
  sdk: SdkStream,
  extra?: { shutdownGraceMs?: number },
): Promise<{ daemon: Daemon; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cc-web-daemon-"));
  dirs.push(dir);
  await saveIdentity(dir, {
    runnerId: "runner-a",
    // Nothing listens here: the loop must not depend on a reachable server.
    controlUrl: "ws://127.0.0.1:1/ws/runner",
    credential: "cck_test",
  });

  const daemon = await startDaemon({
    identityDir: dir,
    runnerVersion: "0.0.0",
    sdkVersion: "0.3.309",
    workspacePathFor: (id) => (id === "workspace-1" ? join(dir, "project") : undefined),
    sdk,
    ...(extra?.shutdownGraceMs === undefined ? {} : { shutdownGraceMs: extra.shutdownGraceMs }),
  });
  daemons.push(daemon);

  return { daemon, dir };
}

afterEach(async () => {
  // A test that failed before its own stop() must not leave a retry chain
  // holding the temp directory open.
  for (const daemon of daemons.splice(0)) {
    try {
      await daemon.stop();
    } catch {
      // Already closed by the test.
    }
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const command = {
  protocolVersion: 1,
  commandId: "cmd-1",
  runnerId: "runner-a",
  kind: "run.start",
  issuedAt: "2026-10-23T00:00:00.000Z",
  sessionId: "session-1",
  runId: "run-1",
  attemptId: "attempt-1",
  workspaceId: "workspace-1",
  payload: { prompt: "hi" },
};

describe("starting the daemon", () => {
  test("comes up with the server unreachable, ready to accept commands", async () => {
    const { daemon } = await setup(() => (async function* () {})());

    expect(daemon.identity.runnerId).toBe("runner-a");
    expect(daemon.db).toBeDefined();
    expect(daemon.runs).toBeDefined();
  });

  test("refuses to start without an identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-web-daemon-"));
    dirs.push(dir);

    // An operator problem, so it fails loudly rather than retrying forever.
    await expect(
      startDaemon({ identityDir: dir, runnerVersion: "0", sdkVersion: "0" }),
    ).rejects.toThrow(/identity missing/);
  });
});

describe("shutdown with a run in flight", () => {
  test("stop waits for the run instead of closing the database under it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { daemon, dir } = await setup(() =>
      (async function* () {
        // Holds the run open until the test says so.
        await gate;
        yield { type: "result", subtype: "success", result: "ok" };
      })(),
    );

    expect((await daemon.runs.handle(command)).accepted).toBe(true);

    // The receipt came back before the run finished (§9.4) — that is what makes
    // the ordering below observable at all.
    expect(attemptState(daemon.db, "attempt-1")).toBe("starting");

    const stopping = daemon.stop();
    release();
    await stopping;

    // Read through a fresh connection: the daemon's own handle is closed.
    const db = new Database(join(dir, "runner.db"), { readonly: true });
    try {
      const events = db
        .prepare("SELECT type FROM event_outbox ORDER BY local_sequence")
        .all() as Array<{ type: string }>;
      expect(events.map((e) => e.type)).toContain("run.finished");

      const attempt = db
        .prepare("SELECT state FROM local_attempts WHERE attempt_id = ?")
        .get("attempt-1") as { state: string } | undefined;
      expect(attempt?.state).toBe("finished");

      const lock = db
        .prepare("SELECT attempt_id FROM workspace_locks WHERE workspace_path = ?")
        .get(join(dir, "project"));
      expect(lock).toBeNull();
    } finally {
      db.close();
    }
  });

  test("stop aborts a hanging run instead of waiting forever", async () => {
    // A stream that never settles and ignores its abort signal: the shape a
    // wedged SDK subprocess would leave behind. Before drain(), stop() waited
    // on settle() with no ceiling — this test would hang, not fail.
    const zombie: SdkStream = () => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Record<string, unknown>>>((_resolve) => {}),
        };
      },
    });

    const { daemon, dir } = await setup(zombie, { shutdownGraceMs: 20 });

    expect((await daemon.runs.handle(command)).accepted).toBe(true);

    // Bounded: the two grace windows pass, the run is abandoned, stop returns.
    await daemon.stop();

    const db = new Database(join(dir, "runner.db"), { readonly: true });
    try {
      // §20.4/§9.7: the abandoned attempt is interrupted and its lock freed —
      // the same verdict the next boot's sweep would reach, written at shutdown.
      const attempt = db
        .prepare("SELECT state FROM local_attempts WHERE attempt_id = ?")
        .get("attempt-1") as { state: string } | undefined;
      expect(attempt?.state).toBe("interrupted");

      const lock = db
        .prepare("SELECT attempt_id FROM workspace_locks WHERE workspace_path = ?")
        .get(join(dir, "project"));
      expect(lock).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("boot recovery", () => {
  test("an attempt left in flight by the previous process is interrupted, not resumed", async () => {
    // First boot, then a hard stop: write the row and the lock the way a
    // process that died mid-run leaves them. This is the state §9.7 is about.
    const first = await setup(() => (async function* () {})());
    first.daemon.db
      .prepare(
        `INSERT INTO local_attempts (attempt_id, session_id, run_id, state, started_at, updated_at)
         VALUES (?, ?, ?, 'starting', ?, ?)`,
      )
      .run("attempt-old", "session-1", "run-old", 1_000, 1_000);
    first.daemon.db
      .prepare(
        "INSERT INTO workspace_locks (workspace_path, attempt_id, acquired_at) VALUES (?, ?, ?)",
      )
      .run(join(first.dir, "project"), "attempt-old", 1_000);
    const dir = first.dir;
    await first.daemon.stop();
    daemons.pop();

    // Second boot against the same database.
    const second = await startDaemon({
      identityDir: dir,
      runnerVersion: "0.0.0",
      sdkVersion: "0.3.309",
      sdk: () => (async function* () {})(),
    });
    daemons.push(second);

    // §9.7: an ambiguous launch is interrupted. Auto-respawning would run work
    // nobody knows the state of.
    expect(attemptState(second.db, "attempt-old")).toBe("interrupted");
    expect(lockHolder(second.db, join(dir, "project"))).toBeUndefined();
  });
});

describe("the hello frame", () => {
  test("carries the workspaces the daemon declares", () => {
    const frame = helloFrame({
      runnerId: "runner-a",
      runnerVersion: "0.0.0",
      sdkVersion: "0.3.309",
      bootId: "boot-1",
      declaredWorkspaces: [{ workspaceId: "default", path: "/srv/proj" }],
    });
    expect(frame).toMatchObject({
      protocolVersion: 1,
      runnerId: "runner-a",
      workspaces: [{ workspaceId: "default", path: "/srv/proj" }],
    });
  });

  test("an empty declaration is sent as an empty list, never omitted", () => {
    const frame = helloFrame({
      runnerId: "runner-a",
      runnerVersion: "0.0.0",
      sdkVersion: "0.3.309",
      bootId: "boot-1",
    });
    expect(frame["workspaces"]).toEqual([]);
  });
});
