import { describe, expect, test } from "bun:test";
import {
  parseDeclaredWorkspaces,
  type RunState,
  reconcile,
  type ServerRunState,
} from "./reconcile.ts";

/**
 * §14.3 reconciliation and §14.4 conflict matrix.
 *
 * The invariant behind every case: reconciliation may *observe* and *record*,
 * but it must never create a new execution attempt. A reconnect is not
 * permission to rerun work whose outcome is unknown.
 */

function serverState(
  runId: string,
  attemptId: string,
  state: RunState,
  extra: Partial<ServerRunState> = {},
): ServerRunState {
  return {
    runId,
    attemptId,
    state,
    cancelRequested: false,
    ...extra,
  };
}

describe("reconciliation", () => {
  test("a connected runner with nothing in flight becomes ready", () => {
    const result = reconcile({ server: [], runner: [] });

    expect(result.ready).toBe(true);
    // §6.2: ready only after reconciliation. Connected alone is not enough.
    expect(result.actions).toEqual([]);
  });

  test("server queued, runner accepted the same command: record the receipt, do not resend", () => {
    const result = reconcile({
      server: [serverState("run-1", "attempt-1", "queued")],
      runner: [
        {
          runId: "run-1",
          attemptId: "attempt-1",
          state: "accepted",
          commandReceiptId: "cmd-1",
        },
      ],
    });

    // §14.4 row 1. Resending would be harmless thanks to inbox dedup, but the
    // point is the server must know delivery succeeded.
    expect(result.actions).toEqual([
      { kind: "record_receipt", runId: "run-1", attemptId: "attempt-1", commandId: "cmd-1" },
    ]);
    expect(result.ready).toBe(true);
  });

  test("server running, runner reports the same attempt completed: adopt the outcome", () => {
    const result = reconcile({
      server: [serverState("run-1", "attempt-1", "running")],
      runner: [{ runId: "run-1", attemptId: "attempt-1", state: "completed" }],
    });

    // §14.4 row 2. The runner has evidence we lack; take it.
    expect(result.actions).toEqual([
      { kind: "adopt_terminal", runId: "run-1", attemptId: "attempt-1", state: "completed" },
    ]);
    expect(result.ready).toBe(true);
  });

  test("server running, runner says the process is alive: keep observing", () => {
    const result = reconcile({
      server: [serverState("run-1", "attempt-1", "running")],
      runner: [{ runId: "run-1", attemptId: "attempt-1", state: "running", processAlive: true }],
    });

    expect(result.actions).toEqual([
      { kind: "continue_observing", runId: "run-1", attemptId: "attempt-1" },
    ]);
    expect(result.ready).toBe(true);
  });

  test("server running, runner has no process and no terminal outcome: interrupted, no retry", () => {
    const result = reconcile({
      server: [serverState("run-1", "attempt-1", "running")],
      runner: [{ runId: "run-1", attemptId: "attempt-1", state: "unknown", processAlive: false }],
    });

    // §14.4 row 4 and §9.7. The critical negative: no action creates a new attempt.
    expect(result.actions).toEqual([
      { kind: "mark_interrupted", runId: "run-1", attemptId: "attempt-1" },
    ]);
    expect(result.ready).toBe(true);
  });

  test("runner has a process for an attempt the server never assigned: quarantine", () => {
    const result = reconcile({
      server: [],
      runner: [
        { runId: "run-ghost", attemptId: "attempt-ghost", state: "running", processAlive: true },
      ],
    });

    // §14.4 row 5. Never attach it to a session; it is evidence, not work.
    expect(result.actions).toEqual([
      {
        kind: "quarantine",
        runId: "run-ghost",
        attemptId: "attempt-ghost",
        reason: "no_assignment",
      },
    ]);
    expect(result.ready).toBe(true);
  });

  test("cancel requested while the runner is still running: resend the cancel under the same id", () => {
    const result = reconcile({
      server: [
        serverState("run-1", "attempt-1", "running", {
          cancelRequested: true,
          cancelCommandId: "cmd-1",
        }),
      ],
      runner: [{ runId: "run-1", attemptId: "attempt-1", state: "running", processAlive: true }],
    });

    expect(result.actions).toEqual([
      { kind: "resend_cancel", runId: "run-1", attemptId: "attempt-1", commandId: "cmd-1" },
    ]);
  });

  test("a cancel without a persisted command id is audited, not reissued under a new id", () => {
    const result = reconcile({
      server: [serverState("run-1", "attempt-1", "running", { cancelRequested: true })],
      runner: [{ runId: "run-1", attemptId: "attempt-1", state: "running", processAlive: true }],
    });

    // Minting a fresh id here would create a second cancel command. The gap is
    // the operator's problem to see, not something to paper over.
    expect(result.actions).toContainEqual({
      kind: "audit",
      detail: "cancel_command_missing",
      runId: "run-1",
      attemptId: "attempt-1",
    });
    expect(result.actions).not.toContainEqual(expect.objectContaining({ kind: "resend_cancel" }));
  });

  test("cancel requested but the runner already finished: record the real outcome, audit late cancel", () => {
    const result = reconcile({
      server: [serverState("run-1", "attempt-1", "running", { cancelRequested: true })],
      runner: [{ runId: "run-1", attemptId: "attempt-1", state: "completed" }],
    });

    // §14.2: the outcome may have arrived before the cancel did. Never rewrite
    // a successful run as cancelled just because a cancel was requested.
    expect(result.actions).toEqual([
      { kind: "adopt_terminal", runId: "run-1", attemptId: "attempt-1", state: "completed" },
      { kind: "audit", detail: "cancel_too_late", runId: "run-1", attemptId: "attempt-1" },
    ]);
  });

  test("a pending approval whose callback is gone is abandoned, not re-offered", () => {
    const result = reconcile({
      server: [serverState("run-1", "attempt-1", "waiting_for_approval")],
      runner: [
        {
          runId: "run-1",
          attemptId: "attempt-1",
          state: "unknown",
          processAlive: false,
          approvalsAlive: false,
        },
      ],
    });

    // §14.4 row 7 and §13.2. Re-offering a stale approval would let a decision
    // made for an old callback be applied to a new one.
    expect(result.actions).toContainEqual({
      kind: "abandon_approval",
      runId: "run-1",
      attemptId: "attempt-1",
    });
    expect(result.actions).toContainEqual({
      kind: "mark_interrupted",
      runId: "run-1",
      attemptId: "attempt-1",
    });
  });

  test("an old attempt reporting late data is kept as evidence and cannot seize the current assignment", () => {
    const result = reconcile({
      server: [serverState("run-1", "attempt-2", "running")],
      runner: [
        { runId: "run-1", attemptId: "attempt-1", state: "completed" },
        { runId: "run-1", attemptId: "attempt-2", state: "running", processAlive: true },
      ],
    });

    // §14.4 row 8. The stale attempt's events are retained; it is not promoted.
    expect(result.actions).toContainEqual({
      kind: "record_stale_evidence",
      runId: "run-1",
      attemptId: "attempt-1",
    });
    expect(result.actions).toContainEqual({
      kind: "continue_observing",
      runId: "run-1",
      attemptId: "attempt-2",
    });
    // Crucially, nothing adopts attempt-1 as the live outcome.
    expect(result.actions).not.toContainEqual(
      expect.objectContaining({ kind: "adopt_terminal", attemptId: "attempt-1" }),
    );
  });

  test("no action ever creates an execution attempt", () => {
    // A structural guard: every action kind this module can emit is listed here.
    // If someone adds a "retry" or "respawn" action, this test fails on purpose.
    const kinds = new Set<string>();
    const scenarios = [
      { server: [], runner: [] },
      {
        server: [serverState("r", "a", "queued")],
        runner: [{ runId: "r", attemptId: "a", state: "accepted" as const }],
      },
      {
        server: [serverState("r", "a", "running")],
        runner: [{ runId: "r", attemptId: "a", state: "completed" as const }],
      },
      {
        server: [serverState("r", "a", "running")],
        runner: [{ runId: "r", attemptId: "a", state: "unknown" as const, processAlive: false }],
      },
      {
        server: [],
        runner: [{ runId: "g", attemptId: "ga", state: "running" as const, processAlive: true }],
      },
      {
        server: [serverState("r", "a", "running", { cancelRequested: true })],
        runner: [{ runId: "r", attemptId: "a", state: "running" as const, processAlive: true }],
      },
    ];

    for (const scenario of scenarios) {
      for (const action of reconcile(scenario).actions) kinds.add(action.kind);
    }

    expect([...kinds].sort()).toEqual(
      [
        "continue_observing",
        "mark_interrupted",
        "quarantine",
        "record_receipt",
        "adopt_terminal",
        "resend_cancel",
        "audit",
        "abandon_approval",
        "record_stale_evidence",
      ]
        .filter((k) => kinds.has(k))
        .sort(),
    );
    for (const forbidden of ["retry", "respawn", "start_run", "reassign"]) {
      expect(kinds.has(forbidden)).toBe(false);
    }
  });

  test("reconciliation blocks dispatch when the inventory is contradictory", () => {
    const result = reconcile({
      server: [serverState("run-1", "attempt-1", "running")],
      runner: [
        { runId: "run-1", attemptId: "attempt-1", state: "running", processAlive: true },
        { runId: "run-1", attemptId: "attempt-1", state: "completed" },
      ],
    });

    // The same attempt cannot be both alive and finished. Reading it as ready
    // would dispatch new work on contradictory state.
    expect(result.ready).toBe(false);
    expect(result.blockedReason).toBe("contradictory_inventory");
  });

  test("a run in flight on the server but absent from the runner is interrupted, not resumed", () => {
    const result = reconcile({
      server: [serverState("run-1", "attempt-1", "running")],
      runner: [],
    });

    expect(result.actions).toEqual([
      { kind: "mark_interrupted", runId: "run-1", attemptId: "attempt-1" },
    ]);
  });
});

describe("parseDeclaredWorkspaces", () => {
  test("an absent field parses to an empty list (older runners stay compatible)", () => {
    expect(parseDeclaredWorkspaces(undefined)).toEqual([]);
  });

  test("a well-formed list parses to the typed array", () => {
    expect(
      parseDeclaredWorkspaces([
        { workspaceId: "default", path: "/srv/proj" },
        { workspaceId: "w-2", path: "/srv/other" },
      ]),
    ).toEqual([
      { workspaceId: "default", path: "/srv/proj" },
      { workspaceId: "w-2", path: "/srv/other" },
    ]);
  });

  test("anything outside the shape is malformed, not coerced", () => {
    expect(parseDeclaredWorkspaces("default")).toBeUndefined();
    expect(parseDeclaredWorkspaces([{ workspaceId: "w" }])).toBeUndefined();
    expect(parseDeclaredWorkspaces([{ workspaceId: "", path: "/srv" }])).toBeUndefined();
    expect(parseDeclaredWorkspaces([{ workspaceId: "w", path: "" }])).toBeUndefined();
    expect(parseDeclaredWorkspaces([{ workspaceId: "w", path: "/srv" }, "nope"])).toBeUndefined();
    expect(parseDeclaredWorkspaces(null)).toBeUndefined();
    expect(parseDeclaredWorkspaces(42)).toBeUndefined();
  });
});
