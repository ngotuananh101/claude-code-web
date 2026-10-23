import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { attemptState, lockHolder, migrateRunnerDb } from "@cc-web/runner-db";
import type { SdkStream } from "./executor.ts";
import { RunController } from "./run-controller.ts";

/**
 * The seam between the inbox and the executor (§9.3, §10.1).
 *
 * The receipt answers "I have it, durably". This is what turns that durable
 * command into work — and it is the only place where the two facts that make
 * that safe are joined: the inbox decided this is a first delivery, and the
 * attempt table decided this workspace is free.
 *
 * Two things are easy to get wrong and are tested here:
 *
 *  - a duplicate (execute: false) must not reach the SDK at all
 *  - shutdown must be able to wait for runs that are still going, or the
 *    database closes underneath them
 */

function setup() {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  return { db };
}

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
  payload: { prompt: "hello" },
};

/** A stream that never finishes until released, so shutdown is observable. */
function holdableStream(): { sdk: SdkStream; release(): void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const sdk: SdkStream = () =>
    (async function* () {
      await gate;
      yield { type: "result", subtype: "success", result: "ok" };
    })();

  return { sdk, release };
}

const WORKSPACES = new Map([["workspace-1", "/home/runner/project"]]);

describe("accepting a command", () => {
  test("a first delivery begins the attempt and runs it", async () => {
    const { db } = setup();
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk: () =>
        (async function* () {
          yield { type: "result", subtype: "success", result: "ok" };
        })(),
    });

    const receipt = await controller.handle(command);
    await controller.settle();

    expect(receipt).toEqual({ commandId: "cmd-1", attemptId: "attempt-1", accepted: true });
    expect(attemptState(db, "attempt-1")).toBe("finished");
    // The lock is released once the run ends, not held for the process lifetime.
    expect(lockHolder(db, "/home/runner/project")).toBeUndefined();
  });

  test("a redelivered command is receipted but never reaches the SDK", async () => {
    const { db } = setup();
    let calls = 0;
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk: () => {
        calls += 1;
        return (async function* () {
          yield { type: "result", subtype: "success", result: "ok" };
        })();
      },
    });

    await controller.handle(command);
    await controller.settle();
    const second = await controller.handle(command);
    await controller.settle();

    // At-least-once delivery makes this normal, not exceptional (§9.3).
    expect(second.accepted).toBe(true);
    expect(calls).toBe(1);
  });

  test("a command for an unregistered workspace is refused before anything runs", async () => {
    const { db } = setup();
    let reached = false;
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: () => undefined,
      sdk: () => {
        reached = true;
        return (async function* () {})();
      },
    });

    const receipt = await controller.handle(command);
    await controller.settle();

    expect(receipt).toEqual({
      commandId: "cmd-1",
      attemptId: "attempt-1",
      accepted: false,
      reason: "unknown_workspace",
    });
    expect(reached).toBe(false);
    // Refused, so nothing is left behind to reconcile.
    expect(attemptState(db, "attempt-1")).toBeUndefined();
  });

  test("a command refused by the inbox is not executed", async () => {
    const { db } = setup();
    let reached = false;
    const controller = new RunController({
      db,
      localRunnerId: "other-runner",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk: () => {
        reached = true;
        return (async function* () {})();
      },
    });

    const receipt = await controller.handle(command);
    await controller.settle();

    expect(receipt.accepted).toBe(false);
    expect(receipt.reason).toBe("wrong_runner");
    expect(reached).toBe(false);
  });
});

describe("shutdown", () => {
  test("settle waits for a run that is still going", async () => {
    const { db } = setup();
    const { sdk, release } = holdableStream();
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk,
    });

    const receipt = controller.handle(command);
    let settled = false;
    const settling = controller.settle().then(() => {
      settled = true;
    });

    await Bun.sleep(10);
    // The run is mid-flight; closing the database now would lose its events.
    expect(settled).toBe(false);

    release();
    await receipt;
    await settling;

    expect(attemptState(db, "attempt-1")).toBe("finished");
  });

  test("a run that throws is recorded and does not poison settle", async () => {
    const { db } = setup();
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk: () => ({
        [Symbol.asyncIterator]() {
          return { next: () => Promise.reject(new Error("transport died")) };
        },
      }),
    });

    const receipt = await controller.handle(command);
    await controller.settle();

    // The command was accepted, so the receipt says so; the failure is the
    // run's, recorded as its outcome (§9.4).
    expect(receipt.accepted).toBe(true);
    expect(attemptState(db, "attempt-1")).toBe("failed");
  });
});

describe("receipts that carry a refusal reason", () => {
  test("an expired command is refused and never executed", async () => {
    const { db } = setup();
    let reached = false;
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      // Both instants are in the future, so the wall clock cannot make this
      // pass: only the injected clock can decide it expired.
      now: () => Date.parse("2031-01-01T00:00:00.000Z"),
      sdk: () => {
        reached = true;
        return (async function* () {})();
      },
    });

    // §9.5: a start that sat in a queue for hours must not launch just because
    // it is still in the inbox.
    const receipt = await controller.handle({
      ...command,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    await controller.settle();

    expect(receipt).toEqual({
      commandId: "cmd-1",
      attemptId: "attempt-1",
      accepted: false,
      reason: "expired",
    });
    expect(reached).toBe(false);
  });

  test("the same id with different content is refused and audited", async () => {
    const { db } = setup();
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk: () =>
        (async function* () {
          yield { type: "result", subtype: "success", result: "ok" };
        })(),
    });

    await controller.handle(command);
    await controller.settle();

    const second = await controller.handle({
      ...command,
      payload: { prompt: "something else" },
    });

    expect(second.accepted).toBe(false);
    expect(second.reason).toBe("fingerprint_mismatch");
    // The audit row is what makes a conflict investigable later; without it the
    // rejection looks like a plain duplicate.
    expect(
      db.prepare("SELECT reason FROM inbox_rejections WHERE command_id = ?").all("cmd-1"),
    ).toEqual([{ reason: "fingerprint_mismatch" }]);
  });

  test("a malformed envelope is refused without touching the inbox", async () => {
    const { db } = setup();
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk: () => (async function* () {})(),
    });

    const receipt = await controller.handle({ commandId: "cmd-1" });

    expect(receipt).toEqual({
      commandId: "cmd-1",
      attemptId: "",
      accepted: false,
      reason: "malformed",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM command_inbox").get()).toEqual({ n: 0 });
  });
});

describe("workspace contention", () => {
  test("a second run on a busy workspace is refused, not queued", async () => {
    const { db } = setup();
    const { sdk, release } = holdableStream();
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk,
    });

    await controller.handle(command);
    const second = await controller.handle({
      ...command,
      commandId: "cmd-2",
      runId: "run-2",
      attemptId: "attempt-2",
      sessionId: "session-2",
    });

    expect(second).toEqual({
      commandId: "cmd-2",
      attemptId: "attempt-2",
      accepted: false,
      reason: "workspace_busy",
    });
    // The first attempt still owns it.
    expect(lockHolder(db, "/home/runner/project")).toBe("attempt-1");

    release();
    await controller.settle();
  });
});
