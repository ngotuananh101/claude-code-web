import { describe, expect, test } from "bun:test";
import { reconcile } from "./reconcile.ts";
import { RunRegistry } from "./run-registry.ts";

/**
 * RunRegistry applies reconciliation actions and enforces the run invariants.
 * It is the boundary where "the protocol said so" becomes "the server believes so".
 */

function registry() {
  return new RunRegistry();
}

describe("run registry", () => {
  test("a run starts queued and carries desired state separately from observed", () => {
    const r = registry();
    r.createRun({
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      runnerId: "runner-a",
    });

    const run = r.get("run-1");
    // §5.3: desired and observed are separate fields, never one overloaded status.
    expect(run).toMatchObject({
      runId: "run-1",
      attemptId: "attempt-1",
      desiredState: "queued",
      observedState: undefined,
      cancelRequested: false,
    });
  });

  test("a session cannot have two active runs (§2.3 invariant 1)", () => {
    const r = registry();
    r.createRun({
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      runnerId: "runner-a",
    });

    expect(() =>
      r.createRun({
        runId: "run-2",
        attemptId: "attempt-2",
        sessionId: "session-1",
        runnerId: "runner-a",
      }),
    ).toThrow(/active run/);
  });

  test("a new run is allowed after the previous one reaches a terminal state", () => {
    const r = registry();
    r.createRun({
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      runnerId: "runner-a",
    });
    r.apply({ kind: "adopt_terminal", runId: "run-1", attemptId: "attempt-1", state: "completed" });

    expect(() =>
      r.createRun({
        runId: "run-2",
        attemptId: "attempt-2",
        sessionId: "session-1",
        runnerId: "runner-a",
      }),
    ).not.toThrow();
  });

  test("applying adopt_terminal records the observed outcome", () => {
    const r = registry();
    r.createRun({
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      runnerId: "runner-a",
    });
    r.apply({ kind: "adopt_terminal", runId: "run-1", attemptId: "attempt-1", state: "completed" });

    expect(r.get("run-1")).toMatchObject({
      observedState: "completed",
      desiredState: "completed",
    });
  });

  test("mark_interrupted sets an explicit unknown observation, not a failure", () => {
    const r = registry();
    r.createRun({
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      runnerId: "runner-a",
    });
    r.apply({ kind: "mark_interrupted", runId: "run-1", attemptId: "attempt-1" });

    // §9.7: interrupted is not failed. Reporting failed would claim knowledge we
    // do not have about side effects that may or may not have happened.
    expect(r.get("run-1")?.observedState).toBe("interrupted");
    expect(r.get("run-1")?.desiredState).toBe("interrupted");
  });

  test("an interrupted run does not block the session forever", () => {
    const r = registry();
    r.createRun({
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      runnerId: "runner-a",
    });
    r.apply({ kind: "mark_interrupted", runId: "run-1", attemptId: "attempt-1" });

    // A human decides to resume; that is a new run, and the old one must not
    // hold the session lock.
    expect(() =>
      r.createRun({
        runId: "run-2",
        attemptId: "attempt-2",
        sessionId: "session-1",
        runnerId: "runner-a",
      }),
    ).not.toThrow();
  });

  test("cancel is a desired-state flag that does not change the observed state", () => {
    const r = registry();
    r.createRun({
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      runnerId: "runner-a",
    });
    r.requestCancel("run-1");

    // §11.2: the run may still be running. The UI must show both facts.
    expect(r.get("run-1")?.cancelRequested).toBe(true);
    expect(r.get("run-1")?.observedState).toBeUndefined();
  });

  test("a cancelled observed state only comes from the runner, never from the request", () => {
    const r = registry();
    r.createRun({
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      runnerId: "runner-a",
    });
    r.requestCancel("run-1");

    // Still not cancelled — the request is not the outcome.
    expect(r.get("run-1")?.observedState).toBeUndefined();

    r.apply({ kind: "adopt_terminal", runId: "run-1", attemptId: "attempt-1", state: "cancelled" });
    expect(r.get("run-1")?.observedState).toBe("cancelled");
  });

  test("a terminal state is not overwritten by a later conflicting action", () => {
    const r = registry();
    r.createRun({
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      runnerId: "runner-a",
    });
    r.apply({ kind: "adopt_terminal", runId: "run-1", attemptId: "attempt-1", state: "completed" });

    r.apply({ kind: "mark_interrupted", runId: "run-1", attemptId: "attempt-1" });

    // §22.2: terminal transitions are idempotent. A stray late action must not
    // retract a known outcome.
    expect(r.get("run-1")?.observedState).toBe("completed");
  });

  test("applying an action for an attempt that is not current is ignored", () => {
    const r = registry();
    r.createRun({
      runId: "run-1",
      attemptId: "attempt-2",
      sessionId: "session-1",
      runnerId: "runner-a",
    });

    // A stale attempt's action must not mutate the live one (§14.4 row 8).
    r.apply({ kind: "adopt_terminal", runId: "run-1", attemptId: "attempt-1", state: "failed" });

    expect(r.get("run-1")?.observedState).toBeUndefined();
  });

  test("quarantined attempts are recorded but never attached to a session", () => {
    const r = registry();
    r.apply({
      kind: "quarantine",
      runId: "ghost",
      attemptId: "attempt-ghost",
      reason: "no_assignment",
    });

    expect(r.quarantined()).toEqual([
      { runId: "ghost", attemptId: "attempt-ghost", reason: "no_assignment" },
    ]);
    expect(r.get("ghost")).toBeUndefined();
  });

  test("active runs per session reflect observed state, not the request", () => {
    const r = registry();
    r.createRun({
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      runnerId: "runner-a",
    });
    r.requestCancel("run-1");

    // The cancel was requested but not confirmed; the session is still busy.
    expect(r.activeRunFor("session-1")?.runId).toBe("run-1");

    r.apply({ kind: "adopt_terminal", runId: "run-1", attemptId: "attempt-1", state: "cancelled" });
    expect(r.activeRunFor("session-1")).toBeUndefined();
  });
});

describe("reconcile + registry", () => {
  test("reconciliation of a live run leaves the session busy", () => {
    const r = registry();
    r.createRun({
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      runnerId: "runner-a",
    });

    const result = reconcile({
      server: [
        { runId: "run-1", attemptId: "attempt-1", state: "running", cancelRequested: false },
      ],
      runner: [{ runId: "run-1", attemptId: "attempt-1", state: "running", processAlive: true }],
    });

    expect(result.ready).toBe(true);
    for (const action of result.actions) r.apply(action);

    expect(r.activeRunFor("session-1")?.runId).toBe("run-1");
  });

  test("reconciliation of a lost process frees the session for an explicit resume", () => {
    const r = registry();
    r.createRun({
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      runnerId: "runner-a",
    });

    const result = reconcile({
      server: [
        { runId: "run-1", attemptId: "attempt-1", state: "running", cancelRequested: false },
      ],
      runner: [],
    });
    for (const action of result.actions) r.apply(action);

    expect(r.get("run-1")?.observedState).toBe("interrupted");
    expect(r.activeRunFor("session-1")).toBeUndefined();
  });
});
