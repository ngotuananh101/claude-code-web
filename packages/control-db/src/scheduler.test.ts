import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "@cc-web/control-db";
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
