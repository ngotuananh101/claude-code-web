import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  attemptState,
  insertPendingApproval,
  lockHolder,
  migrateRunnerDb,
  pendingApproval,
} from "@cc-web/runner-db";
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

describe("cancelling a run", () => {
  /**
   * A stream shaped like the real SDK under abort (§14.2): it holds until the
   * abort fires, then throws an ordinary `Error` — nothing about the object
   * identifies the abort, which is exactly why the runner's own signal has to
   * be the witness.
   */
  function abortableStream(): SdkStream {
    return (options) =>
      (async function* () {
        await new Promise<never>((_, reject) => {
          options.abort?.addEventListener("abort", () => reject(new Error("Operation aborted")), {
            once: true,
          });
        });
      })();
  }

  test("a cancel command aborts the in-flight run and it is recorded interrupted", async () => {
    const { db } = setup();
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk: abortableStream(),
    });

    await controller.handle(command);

    const cancel = await controller.handle({
      protocolVersion: 1,
      commandId: "cmd-cancel",
      runnerId: "runner-a",
      kind: "run.cancel",
      issuedAt: "2026-10-23T00:00:01.000Z",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      payload: null,
    });
    await controller.settle();

    // The cancel itself is durable and receipted; it names the run it stops.
    expect(cancel).toEqual({
      commandId: "cmd-cancel",
      attemptId: "attempt-1",
      accepted: true,
    });

    // §14.2: cancelled, not failed — and the cancel command must not become a
    // run of its own, which is what treating every command as a start would do.
    expect(attemptState(db, "attempt-1")).toBe("interrupted");
    expect(attemptState(db, "cmd-cancel")).toBeUndefined();
    expect(lockHolder(db, "/home/runner/project")).toBeUndefined();

    const types = db
      .prepare("SELECT type FROM event_outbox ORDER BY local_sequence")
      .all() as Array<{ type: string }>;
    expect(types.map((t) => t.type)).toContain("run.interrupted");
  });

  test("a cancel can find its target by run id when no attempt id is given", async () => {
    const { db } = setup();
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk: abortableStream(),
    });

    await controller.handle(command);

    const cancel = await controller.handle({
      protocolVersion: 1,
      commandId: "cmd-cancel",
      runnerId: "runner-a",
      kind: "run.cancel",
      issuedAt: "2026-10-23T00:00:01.000Z",
      runId: "run-1",
      payload: null,
    });
    await controller.settle();

    expect(cancel.accepted).toBe(true);
    expect(attemptState(db, "attempt-1")).toBe("interrupted");
  });

  test("a cancel for a run that is already over changes nothing", async () => {
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

    // §14.2: the run really finished before the cancel arrived. The observed
    // outcome stands; the cancel is durable and honest about doing nothing.
    const cancel = await controller.handle({
      protocolVersion: 1,
      commandId: "cmd-cancel",
      runnerId: "runner-a",
      kind: "run.cancel",
      issuedAt: "2026-10-23T00:00:01.000Z",
      runId: "run-1",
      attemptId: "attempt-1",
      payload: null,
    });

    expect(cancel.accepted).toBe(true);
    expect(attemptState(db, "attempt-1")).toBe("finished");
  });

  test("a cancel naming an unknown run is receipted and aborts nothing", async () => {
    const { db } = setup();
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk: () => (async function* () {})(),
    });

    const cancel = await controller.handle({
      protocolVersion: 1,
      commandId: "cmd-cancel",
      runnerId: "runner-a",
      kind: "run.cancel",
      issuedAt: "2026-10-23T00:00:01.000Z",
      runId: "run-nobody",
      payload: null,
    });

    expect(cancel.accepted).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM local_attempts").get()).toEqual({ n: 0 });
  });
});

describe("draining", () => {
  /** A stream that ignores everything, including its abort signal. */
  function zombieStream(): SdkStream {
    return () => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Record<string, unknown>>>((_resolve) => {}),
        };
      },
    });
  }

  test("drain waits out the grace period for a run that finishes on its own", async () => {
    const { db } = setup();
    const { sdk, release } = holdableStream();
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk,
    });

    await controller.handle(command);
    Bun.sleep(5).then(release);

    const result = await controller.drain({ graceMs: 500 });

    // Natural completion inside the window: nothing abandoned, real outcome kept.
    expect(result).toEqual({ abandoned: [] });
    expect(attemptState(db, "attempt-1")).toBe("finished");
  });

  test("drain aborts a run that outlives the grace period", async () => {
    const { db } = setup();
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      // Holds like a live SDK stream, then throws on abort the way the SDK does.
      sdk: (options) =>
        (async function* () {
          await new Promise<never>((_, reject) => {
            options.abort?.addEventListener("abort", () => reject(new Error("Operation aborted")), {
              once: true,
            });
          });
        })(),
    });

    await controller.handle(command);

    const result = await controller.drain({ graceMs: 10 });

    // §20.4: deliberate cancel after the grace period. The executor observes
    // the abort, so the run ends interrupted — not abandoned.
    expect(result).toEqual({ abandoned: [] });
    expect(attemptState(db, "attempt-1")).toBe("interrupted");
    expect(lockHolder(db, "/home/runner/project")).toBeUndefined();
  });

  test("drain abandons a run that survives its own abort, and records it interrupted", async () => {
    const { db } = setup();
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk: zombieStream(),
    });

    await controller.handle(command);

    const result = await controller.drain({ graceMs: 10 });

    // The run ignored the abort — the shape a wedged SDK subprocess would leave.
    // drain still returns (shutdown is bounded), and the database already tells
    // the truth: interrupted with the lock freed, the same verdict the next
    // boot's sweep would reach (§9.7), reached now instead of later.
    expect(result.abandoned).toEqual(["attempt-1"]);
    expect(attemptState(db, "attempt-1")).toBe("interrupted");
    expect(lockHolder(db, "/home/runner/project")).toBeUndefined();
  });

  test("no new run is accepted once draining has begun", async () => {
    const { db } = setup();
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk: zombieStream(),
    });

    await controller.handle(command);
    const draining = controller.drain({ graceMs: 50 });
    await Bun.sleep(5);

    // §20.4: draining means no new accepts or starts. The receipt refuses, so
    // the server redelivers after the restart instead of trusting work into a
    // process that is on its way out.
    const late = await controller.handle({
      ...command,
      commandId: "cmd-2",
      runId: "run-2",
      attemptId: "attempt-2",
    });
    expect(late).toEqual({
      commandId: "cmd-2",
      attemptId: "attempt-2",
      accepted: false,
      reason: "draining",
    });
    // Refused before an attempt row exists: nothing for reconciliation to
    // explain, and the command stays the server's to redeliver.
    expect(attemptState(db, "attempt-2")).toBeUndefined();

    await draining;
  });
});

describe("notifying the event pump", () => {
  test("a settled run reports its attempt id to the onSettled hook", async () => {
    const { db } = setup();
    const settled: string[] = [];
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk: () =>
        (async function* () {
          yield { type: "result", subtype: "success", result: "ok" };
        })(),
      onSettled: (attemptId) => settled.push(attemptId),
    });

    await controller.handle(command);
    await controller.settle();

    // The hook is what turns "the run is over" into "send its events now"
    // without the controller knowing a socket exists.
    expect(settled).toEqual(["attempt-1"]);
  });

  test("a failed run settles too — its events still need delivery", async () => {
    const { db } = setup();
    const settled: string[] = [];
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk: () => ({
        [Symbol.asyncIterator]() {
          return { next: () => Promise.reject(new Error("transport died")) };
        },
      }),
      onSettled: (attemptId) => settled.push(attemptId),
    });

    await controller.handle(command);
    await controller.settle();

    expect(settled).toEqual(["attempt-1"]);
  });
});

describe("approvals", () => {
  /**
   * A stream shaped like the real SDK around `canUseTool` (§13): it parks the
   * run on the callback and dies on abort — the abort is the only way the run
   * observes a cancel while suspended, because the callback's promise does not
   * reject on its own.
   */
  function approvalStream(): { sdk: SdkStream; release(): void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sdk: SdkStream = (options) =>
      (async function* () {
        const canUseTool = options.canUseTool;
        if (canUseTool === undefined) throw new Error("canUseTool missing");
        const signal = options.abort ?? new AbortController().signal;
        await Promise.race([
          canUseTool("Bash", { command: "ls" }, { signal }),
          new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("Operation aborted")), {
              once: true,
            });
          }),
        ]);
        await gate;
        yield { type: "result", subtype: "success", result: "ok" };
      })();
    return { sdk, release };
  }

  function respondCommand(payload: Record<string, unknown>): unknown {
    return {
      protocolVersion: 1,
      commandId: "cmd-respond",
      runnerId: "runner-a",
      kind: "approval.respond",
      issuedAt: "2026-10-23T00:00:01.000Z",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      payload,
    };
  }

  test("a suspended run announces approval.requested, flushes the pump, and reports waiting", async () => {
    const { db } = setup();
    const { sdk, release } = approvalStream();
    let flushes = 0;
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk,
      onApprovalEvent: () => {
        flushes += 1;
      },
    });

    const receipt = await controller.handle(command);
    expect(receipt.accepted).toBe(true);
    await Bun.sleep(10);

    // The card exists only if the event ships — a suspended run never settles,
    // so the flush trigger fires on every approval append (§13).
    const requested = db
      .prepare("SELECT payload FROM event_outbox WHERE type = 'approval.requested'")
      .all() as Array<{ payload: string }>;
    expect(requested).toHaveLength(1);
    const payload = JSON.parse(requested[0]!.payload) as Record<string, unknown>;
    expect(payload.attemptId).toBe("attempt-1");
    expect(payload.runId).toBe("run-1");
    expect(payload.toolName).toBe("Bash");
    expect(flushes).toBeGreaterThanOrEqual(1);

    expect(controller.inventory()).toEqual([
      {
        runId: "run-1",
        attemptId: "attempt-1",
        state: "waiting_for_approval",
        processAlive: true,
        approvalsAlive: true,
      },
    ]);

    // Let the run finish so the test leaves nothing parked.
    await controller.handle(
      respondCommand({
        approvalId: payload.approvalId,
        decision: "allow",
        inputHash: payload.inputHash,
      }),
    );
    release();
    await controller.settle();
  });

  test("an approval.respond command resolves the callback and the run finishes", async () => {
    const { db } = setup();
    const { sdk, release } = approvalStream();
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk,
    });

    await controller.handle(command);
    await Bun.sleep(10);
    const requested = db
      .prepare("SELECT payload FROM event_outbox WHERE type = 'approval.requested'")
      .get() as { payload: string };
    const payload = JSON.parse(requested.payload) as Record<string, unknown>;

    const receipt = await controller.handle(
      respondCommand({
        approvalId: payload.approvalId,
        decision: "allow",
        inputHash: payload.inputHash,
      }),
    );
    expect(receipt.accepted).toBe(true);

    // Waiting has flipped off, but the run is still in flight.
    expect(controller.inventory()).toEqual([
      {
        runId: "run-1",
        attemptId: "attempt-1",
        state: "running",
        processAlive: true,
        approvalsAlive: false,
      },
    ]);

    release();
    await controller.settle();

    expect(attemptState(db, "attempt-1")).toBe("finished");
    const types = db
      .prepare("SELECT type FROM event_outbox WHERE type LIKE 'approval.%'")
      .all() as Array<{ type: string }>;
    expect(types.map((t) => t.type)).toContain("approval.resolved");
  });

  test("a cancel while suspended records interrupted and expires the approval", async () => {
    const { db } = setup();
    const { sdk } = approvalStream();
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk,
    });

    await controller.handle(command);
    await Bun.sleep(10);

    await controller.handle({
      protocolVersion: 1,
      commandId: "cmd-cancel",
      runnerId: "runner-a",
      kind: "run.cancel",
      issuedAt: "2026-10-23T00:00:01.000Z",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      payload: null,
    });
    await controller.settle();

    expect(attemptState(db, "attempt-1")).toBe("interrupted");
    const expired = db
      .prepare("SELECT payload FROM event_outbox WHERE type = 'approval.expired'")
      .all() as Array<{ payload: string }>;
    expect(expired).toHaveLength(1);
    const payload = JSON.parse(expired[0]!.payload) as Record<string, unknown>;
    expect(payload.reason).toBe("aborted");
  });

  test("a respond naming an unknown approval is receipted with its refusal and resolves nothing", async () => {
    const { db } = setup();
    const { sdk, release } = approvalStream();
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk,
    });

    const receipt = await controller.handle(
      respondCommand({ approvalId: "apr-missing", decision: "allow", inputHash: "h" }),
    );

    // Accepted — the command was delivered and persisted; the refusal is the
    // decision's, carried as the reason (§9.4).
    expect(receipt).toEqual({
      commandId: "cmd-respond",
      attemptId: "attempt-1",
      accepted: true,
      reason: "unknown",
    });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM event_outbox WHERE type LIKE 'approval.%'").get(),
    ).toEqual({ n: 0 });

    release();
    await controller.settle();
  });

  test("a respond for an attempt with no registered router is refused without touching the row", async () => {
    const { db } = setup();
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk: () => (async function* () {})(),
    });

    // The race the old fallback papered over: the run settled and its router
    // is gone, but its pending row has not been swept yet. A redelivered
    // approval.respond must not resolve the row through a mute append — the
    // decision would be recorded with no approval.resolved ever shipping.
    insertPendingApproval(db, {
      approvalId: "apr-late",
      attemptId: "attempt-late",
      toolCallId: "tc-late",
      inputHash: "hash-late",
      callbackGeneration: 0,
      kind: "tool_permission",
      expiresAt: Date.now() + 60_000,
    });

    const receipt = await controller.handle({
      protocolVersion: 1,
      commandId: "cmd-late",
      runnerId: "runner-a",
      kind: "approval.respond",
      issuedAt: "2026-10-23T00:00:01.000Z",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-late",
      payload: { approvalId: "apr-late", decision: "allow", inputHash: "hash-late" },
    });

    // Accepted — delivered and persisted; the refusal is the decision's (§9.4).
    expect(receipt).toEqual({
      commandId: "cmd-late",
      attemptId: "attempt-late",
      accepted: true,
      reason: "unknown",
    });
    expect(pendingApproval(db, "apr-late")?.state).toBe("pending");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM event_outbox WHERE type LIKE 'approval.%'").get(),
    ).toEqual({ n: 0 });
  });

  test("boot sweep expires approvals of dead attempts in place, without events", () => {
    const { db } = setup();
    insertPendingApproval(db, {
      approvalId: "apr-dead",
      attemptId: "attempt-dead",
      toolCallId: "tc-dead",
      inputHash: "hash-dead",
      callbackGeneration: 0,
      kind: "tool_permission",
      expiresAt: 9_999,
      now: 1_000,
    });

    new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk: () => (async function* () {})(),
    });

    // §9.7: nothing is in flight at construction, so every pending approval
    // belongs to an attempt this process already interrupted. §18.3: the dead
    // attempt's stream is complete — no fabricated approval.expired event.
    expect(pendingApproval(db, "apr-dead")?.state).toBe("expired");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM event_outbox WHERE type LIKE 'approval.%'").get(),
    ).toEqual({ n: 0 });
  });
});

describe("workspace preparation (M4)", () => {
  test("the branch from the payload reaches the gate with the resolved path", async () => {
    const { db } = setup();
    const seen: Array<{ workspacePath: string; branch: string | undefined }> = [];
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk: () =>
        (async function* () {
          yield { type: "result", subtype: "success", result: "ok" };
        })(),
      prepareWorkspace: async (workspacePath, branch) => {
        seen.push({ workspacePath, branch });
        return { kind: "ready", checkedOut: true, branch };
      },
    });

    await controller.handle({ ...command, payload: { prompt: "hello", branch: "dev" } });
    await controller.settle();

    expect(seen).toEqual([{ workspacePath: "/home/runner/project", branch: "dev" }]);
    expect(attemptState(db, "attempt-1")).toBe("finished");
  });

  test("a gate refusal fails the attempt and releases the workspace", async () => {
    const { db } = setup();
    const controller = new RunController({
      db,
      localRunnerId: "runner-a",
      workspacePathFor: (id) => WORKSPACES.get(id),
      sdk: () =>
        (async function* () {
          yield { type: "result", subtype: "success", result: "ok" };
        })(),
      prepareWorkspace: async () => ({ kind: "refused", reason: "dirty_tree", branch: "dev" }),
    });

    const receipt = await controller.handle({ ...command, payload: { prompt: "hello", branch: "dev" } });
    await controller.settle();

    expect(receipt.accepted).toBe(true);
    expect(attemptState(db, "attempt-1")).toBe("failed");
    expect(lockHolder(db, "/home/runner/project")).toBeUndefined();
  });
});
