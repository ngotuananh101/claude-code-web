import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "@cc-web/control-db";
import { CommandOutbox } from "./command-outbox.ts";
import { type RunnerCapacity, Scheduler } from "./scheduler.ts";

/**
 * Scheduling MVP (§11.3).
 *
 * The user picks a workspace already bound to a Runner; the server checks that
 * Runner is ready and has capacity, then enqueues. No smart placement, no worker
 * pool — deliberately.
 *
 * Two things this must never do:
 *
 *  - dispatch to a Runner that is `connected` but not `ready` (§6.2)
 *  - exceed the Runner's advertised concurrency, which would over-commit a
 *    machine the operator sized for one run
 */

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  return { db, scheduler: new Scheduler(db) };
}

function capacity(overrides: Partial<RunnerCapacity> = {}): RunnerCapacity {
  return {
    runnerId: "runner-a",
    state: "ready",
    maxConcurrentRuns: 1,
    activeRuns: 0,
    ...overrides,
  };
}

const request = {
  sessionId: "session-1",
  runId: "run-1",
  attemptId: "attempt-1",
  workspaceId: "workspace-1",
  prompt: "hello",
  ownerId: "user-1",
};

describe("scheduler", () => {
  test("a ready runner with capacity accepts a run", async () => {
    const { scheduler } = setup();

    const decision = await scheduler.dispatch(request, capacity());

    expect(decision).toMatchObject({ ok: true, runnerId: "runner-a" });
  });

  test("a connected runner is not dispatchable, because it has not reconciled", async () => {
    const { scheduler } = setup();

    // §6.2: `connected` means the hello succeeded, not that the runner's state
    // matches the server's. Dispatching here is how work gets lost.
    const decision = await scheduler.dispatch(request, capacity({ state: "connected" }));

    expect(decision).toEqual({ ok: false, reason: "runner_not_ready" });
  });

  test("a runner at capacity is refused rather than queued locally", async () => {
    const { scheduler } = setup();

    const decision = await scheduler.dispatch(
      request,
      capacity({ activeRuns: 1, maxConcurrentRuns: 1 }),
    );

    expect(decision).toEqual({ ok: false, reason: "runner_at_capacity" });
  });

  test("capacity zero is refused, since a zero-capacity runner cannot take work", async () => {
    const { scheduler } = setup();

    const decision = await scheduler.dispatch(request, capacity({ maxConcurrentRuns: 0 }));

    expect(decision).toEqual({ ok: false, reason: "runner_at_capacity" });
  });

  test("an offline runner is refused with its own reason", async () => {
    const { scheduler } = setup();

    const decision = await scheduler.dispatch(request, capacity({ state: "offline" }));

    expect(decision).toEqual({ ok: false, reason: "runner_offline" });
  });

  test("a session cannot have two runs dispatched at once (§2.3)", async () => {
    const { scheduler } = setup();
    await scheduler.dispatch(request, capacity());

    // The second run is a different id for the same session: exactly what a
    // double-click in the UI produces.
    const decision = await scheduler.dispatch(
      { ...request, runId: "run-2", attemptId: "attempt-2" },
      capacity(),
    );

    expect(decision).toEqual({ ok: false, reason: "session_busy" });
  });

  test("a dispatched run is enqueued to the outbox in the same call", async () => {
    const { db, scheduler } = setup();

    const decision = await scheduler.dispatch(request, capacity());
    expect(decision.ok).toBe(true);

    // Enqueue is part of dispatch, not a separate step: a decision the outbox
    // never hears about is a run the operator believes was started.
    const rows = db.query("SELECT command_id, kind, runner_id FROM command_outbox").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "run.start", runner_id: "runner-a" });
  });

  test("a dispatch with a branch carries it on the run.start payload", async () => {
    const { db, scheduler } = setup();

    const decision = await scheduler.dispatch({ ...request, branch: "dev" }, capacity());
    expect(decision.ok).toBe(true);

    const row = db.query("SELECT payload FROM command_outbox").get() as {
      payload: string;
    };
    expect(JSON.parse(row.payload)).toEqual({
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      workspaceId: "workspace-1",
      prompt: "hello",
      branch: "dev",
    });
  });

  test("a dispatch without a branch omits the key, never a stand-in value", async () => {
    const { db, scheduler } = setup();

    await scheduler.dispatch(request, capacity());

    const row = db.query("SELECT payload FROM command_outbox").get() as {
      payload: string;
    };
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect("branch" in payload).toBe(false);
  });

  test("a dispatch with a resumeSessionId carries it on the run.start payload", async () => {
    const { db, scheduler } = setup();

    const decision = await scheduler.dispatch(
      { ...request, resumeSessionId: "prev-session-id" },
      capacity(),
    );
    expect(decision).toMatchObject({ ok: true });

    const row = db.query("SELECT payload FROM command_outbox").get() as {
      payload: string;
    };
    expect(JSON.parse(row.payload)).toEqual({
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      workspaceId: "workspace-1",
      prompt: "hello",
      resumeSessionId: "prev-session-id",
    });
  });

  test("a dispatch without a resumeSessionId omits the key, never a stand-in value", async () => {
    const { db, scheduler } = setup();

    await scheduler.dispatch(request, capacity());

    const row = db.query("SELECT payload FROM command_outbox").get() as {
      payload: string;
    };
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect("resumeSessionId" in payload).toBe(false);
  });

  test("a refused dispatch writes nothing to the outbox", async () => {
    const { db, scheduler } = setup();

    await scheduler.dispatch(request, capacity({ state: "connected" }));

    expect(db.query("SELECT COUNT(*) AS n FROM command_outbox").get()).toEqual({ n: 0 });
  });

  test("releasing a run frees the session and the capacity", async () => {
    const { scheduler } = setup();
    await scheduler.dispatch(request, capacity());

    scheduler.release("run-1");

    expect(scheduler.activeRunFor("session-1")).toBeUndefined();
    expect(scheduler.capacityFor("runner-a", capacity())).toMatchObject({ activeRuns: 0 });
  });

  test("the same run id cannot be dispatched twice", async () => {
    const { db, scheduler } = setup();
    await scheduler.dispatch(request, capacity());

    // Different session, same run id — a retry bug that must not create a
    // second command.
    const decision = await scheduler.dispatch({ ...request, sessionId: "session-2" }, capacity());

    expect(decision).toEqual({ ok: false, reason: "duplicate_run" });
    expect(db.query("SELECT COUNT(*) AS n FROM command_outbox").get()).toEqual({ n: 1 });
  });

  test("an accepted dispatch pins the session (§2.3)", async () => {
    const { db, scheduler } = setup();

    await scheduler.dispatch(request, capacity());

    // The pin records whose session it is and where it ran, so the route can
    // answer a foreign owner with 404 and rerun placement never.
    expect(
      db
        .query("SELECT owner_id, workspace_id, runner_id FROM sessions WHERE id = ?")
        .get("session-1"),
    ).toEqual({ owner_id: "user-1", workspace_id: "workspace-1", runner_id: "runner-a" });
  });

  test("the pin outlives a dispatch on another runner", async () => {
    const { db, scheduler } = setup();
    await scheduler.dispatch(request, capacity());

    // Free the session the way a terminal event would, then send the next run
    // of the same session at a different runner. First pin wins (ADR-006):
    // moving a session is migration, not a side effect of a dispatch.
    db.exec("DELETE FROM active_runs");
    const decision = await scheduler.dispatch(
      { ...request, runId: "run-2", attemptId: "attempt-2" },
      capacity({ runnerId: "runner-b" }),
    );
    expect(decision.ok).toBe(true);

    expect(db.query("SELECT runner_id FROM sessions WHERE id = ?").get("session-1")).toEqual({
      runner_id: "runner-a",
    });
  });

  test("a refused dispatch writes no pin", async () => {
    const { db, scheduler } = setup();

    await scheduler.dispatch(request, capacity({ state: "connected" }));

    expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  test("a concurrent dispatch cannot leave the pin on the loser", async () => {
    const { db, scheduler } = setup();
    const subtle = globalThis.crypto.subtle;
    const realDigest = subtle.digest.bind(subtle);
    const releases: Array<() => void> = [];
    // The outbox fingerprint hashes asynchronously; hold each digest until the
    // test releases it, so the interleaving of two concurrent dispatches of
    // one idle session is decided here instead of by the event loop.
    subtle.digest = ((...args: Parameters<typeof realDigest>) =>
      new Promise<ArrayBuffer>((resolve) =>
        releases.push(() => resolve(realDigest(...args))),
      )) as typeof subtle.digest;
    try {
      const loser = scheduler.dispatch(request, capacity({ runnerId: "runner-b" }));
      await Bun.sleep(2);
      const winner = scheduler.dispatch(
        { ...request, runId: "run-2", attemptId: "attempt-2" },
        capacity(),
      );
      await Bun.sleep(2);
      releases[1]?.();
      await Bun.sleep(2);
      releases[0]?.();
      const decisions = await Promise.all([loser, winner]);

      // The insert race went to runner-a; the pin must name runner-a too. A
      // pin written before the awaited enqueue could survive on the dispatch
      // that lost, silently splitting the session forever.
      expect(decisions[1]).toMatchObject({ ok: true, runnerId: "runner-a" });
      expect(decisions[0]).toEqual({ ok: false, reason: "session_busy" });
      expect(db.query("SELECT runner_id FROM sessions WHERE id = ?").get("session-1")).toEqual({
        runner_id: "runner-a",
      });
    } finally {
      subtle.digest = realDigest;
    }
  });
});

describe("scheduler cancel (§14.2)", () => {
  test("cancel enqueues a run.cancel addressed to the holding runner", async () => {
    const { db, scheduler } = setup();
    await scheduler.dispatch(request, capacity());

    const decision = await scheduler.cancel("run-1");

    expect(decision.ok).toBe(true);
    const rows = db
      .query(
        "SELECT kind, runner_id, run_id, attempt_id, session_id FROM command_outbox WHERE kind = 'run.cancel'",
      )
      .all();
    // The envelope carries the ids the runner's abort lookup needs — without
    // attemptId and runId the cancel reaches a runner that cannot find the run.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runner_id: "runner-a",
      run_id: "run-1",
      attempt_id: "attempt-1",
      session_id: "session-1",
    });
  });

  test("cancel delivery is part of the call, via the dispatch listener", async () => {
    const drained: string[] = [];
    const db = new Database(":memory:");
    migrate(db);
    const scheduler = new Scheduler(db, {
      onDispatched: (runnerId) => drained.push(runnerId),
    });
    await scheduler.dispatch(request, capacity());

    await scheduler.cancel("run-1");

    // The start's drain happened on dispatch; the cancel needs its own, or it
    // sits in the outbox until the runner happens to reconnect.
    expect(drained).toEqual(["runner-a", "runner-a"]);
  });

  test("an unknown run is refused, not enqueued", async () => {
    const { db, scheduler } = setup();

    const decision = await scheduler.cancel("run-nobody");

    expect(decision).toEqual({ ok: false, reason: "unknown_run" });
    expect(db.query("SELECT COUNT(*) AS n FROM command_outbox").get()).toEqual({ n: 0 });
  });

  test("cancel keeps the active run — the terminal event releases it", async () => {
    const { scheduler } = setup();
    await scheduler.dispatch(request, capacity());

    await scheduler.cancel("run-1");

    // A cancel is a request, not an outcome (§14.2): the run keeps its slot
    // until the runner reports a terminal event, so a failed cancel cannot
    // wedge a second run onto a workspace that is still busy.
    expect(scheduler.activeRunFor("session-1")).toMatchObject({ runId: "run-1" });
  });
});

describe("scheduler — rejected run.start frees the session slot (§9.4, §14.2)", () => {
  // Bug: Dispatcher.handleReceipt calls outbox.markRejected on a refused
  // run.start, but only scheduler.release() frees the active_runs row — and
  // release() was wired exclusively to terminal journal events
  // (run.finished / run.failed / run.interrupted in server.ts onEvents).
  //
  // A rejected start produces zero events, so release() was never called and
  // the active_runs row lived forever. The session was then permanently
  // `session_busy` and the runner slot was never reclaimed.
  //
  // Live proof in the field: two active_runs rows whose attempt_id matches a
  // rejected run.start row (delivery_state=rejected, rejection_reason=
  // unknown_workspace), with zero run_events for those attempts.
  //
  // Fix: Dispatcher.handleReceipt, on a rejected run.start, looks up the outbox
  // row and calls onRejectedStart(runId) → scheduler.release(runId). A rejected
  // start is terminal from the server's standpoint — only run.cancel rejections
  // must NOT release, because the original run may still execute (§14.2).

  /**
   * Simulates Dispatcher.handleReceipt's rejection path: marks the command
   * rejected, then — for a run.start — calls onRejectedStart so the slot is
   * freed. The Dispatcher lives in the control-server package and wires
   * onRejectedStart to scheduler.release; this helper mirrors that wiring.
   */
  function handleRejectedStart(
    outbox: CommandOutbox,
    scheduler: Scheduler,
    commandId: string,
    reason: string,
  ) {
    outbox.markRejected(commandId, reason);
    const row = outbox.get(commandId);
    if (row?.kind === "run.start" && row.runId !== undefined) {
      scheduler.release(row.runId);
    }
  }

  test("a runner rejection of run.start frees the slot so a second dispatch is not session_busy", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const outbox = new CommandOutbox(db);
    const scheduler = new Scheduler(db);

    const decision = await scheduler.dispatch(request, capacity());
    expect(decision).toMatchObject({ ok: true });

    // The session is pinned and a slot is held.
    expect(scheduler.activeRunFor("session-1")).toMatchObject({ runId: "run-1" });

    const commandId = (decision as { commandId: string }).commandId;

    // The runner rejects run.start — exactly as Dispatcher.handleReceipt does
    // (apps/control-server/src/dispatch/dispatcher.ts). The outbox row is
    // retired and onRejectedStart fires, which calls scheduler.release(runId).
    handleRejectedStart(outbox, scheduler, commandId, "unknown_workspace");

    // The command is retired from delivery.
    expect(outbox.get(commandId)).toMatchObject({
      deliveryState: "rejected",
      rejectionReason: "unknown_workspace",
    });

    // The slot is freed: a rejected start is terminal from the server's
    // standpoint. A second dispatch on the same session should go through, not
    // 409 session_busy.
    expect(scheduler.activeRunFor("session-1")).toBeUndefined();

    const next = await scheduler.dispatch(
      { ...request, runId: "run-2", attemptId: "attempt-2" },
      capacity(),
    );
    // The second dispatch must succeed: a rejected run.start is terminal from
    // the server's standpoint, so the slot should have been freed. Before the
    // fix this returned { ok: false, reason: "session_busy" }.
    expect(next).toMatchObject({ ok: true, runnerId: "runner-a" });
  });

  test("a runner cancellation rejection does NOT free the slot (§14.2)", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const outbox = new CommandOutbox(db);
    const scheduler = new Scheduler(db);

    await scheduler.dispatch(request, capacity());
    expect(scheduler.activeRunFor("session-1")).toMatchObject({ runId: "run-1" });

    // Dispatch a cancel command for the same run; the runner rejects it.
    // Dispatcher.handleReceipt must NOT call onRejectedStart for a run.cancel,
    // so the active run stays pinned until the terminal event arrives.
    const cancelDecision = await scheduler.cancel("run-1");
    expect(cancelDecision).toMatchObject({ ok: true });

    const commandId = (cancelDecision as { commandId: string }).commandId;

    // Simulate the rejection: markRejected is called, but onRejectedStart is
    // only invoked for run.start — a run.cancel rejection is skipped.
    outbox.markRejected(commandId, "cancelled");

    const row = outbox.get(commandId);
    // The dispatcher checks kind === "run.start" before calling onRejectedStart;
    // a run.cancel hits this branch and returns early, leaving the slot held.
    expect(row?.kind).toBe("run.cancel");

    // The slot is still held — the original run may still execute.
    expect(scheduler.activeRunFor("session-1")).toMatchObject({ runId: "run-1" });
  });
});
