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
