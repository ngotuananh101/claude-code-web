/**
 * In-memory run registry (§5.3, §11.2, §14).
 *
 * This is where reconciliation actions become state, and where the run
 * invariants are enforced:
 *
 *  - one active run per session (§2.3)
 *  - desired state and observed state are separate fields (§5.3)
 *  - a terminal observation is idempotent and cannot be retracted (§22.2)
 *  - an action for a non-current attempt is ignored (§14.4)
 *
 * In-memory on purpose for now: the shape matters more than persistence, and the
 * actions it accepts are already derived from durable state. The Postgres path
 * (§18.4) replaces the storage, not this contract.
 */

import type { ReconcileAction, RunState } from "./reconcile.ts";

export type DesiredState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ObservedState =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type Run = {
  runId: string;
  attemptId: string;
  sessionId: string;
  /** Which runner the work was assigned to; reconciliation is scoped by it. */
  runnerId: string;
  desiredState: DesiredState;
  observedState: ObservedState | undefined;
  cancelRequested: boolean;
};

const ACTIVE_DESIRED: ReadonlySet<DesiredState> = new Set(["queued", "running"]);
const TERMINAL_OBSERVED: ReadonlySet<ObservedState> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export class RunRegistry {
  #runs = new Map<string, Run>();
  #quarantined: Array<{ runId: string; attemptId: string; reason: "no_assignment" }> = [];

  createRun(params: {
    runId: string;
    attemptId: string;
    sessionId: string;
    runnerId: string;
  }): Run {
    const existing = this.activeRunFor(params.sessionId);
    if (existing) {
      // §2.3 invariant 1: one active run per session. Rejecting here rather than
      // queueing keeps the failure visible at the point of the mistake.
      throw new Error(`session ${params.sessionId} already has an active run: ${existing.runId}`);
    }

    const run: Run = {
      runId: params.runId,
      attemptId: params.attemptId,
      sessionId: params.sessionId,
      runnerId: params.runnerId,
      desiredState: "queued",
      observedState: undefined,
      cancelRequested: false,
    };
    this.#runs.set(params.runId, run);
    return run;
  }

  get(runId: string): Run | undefined {
    return this.#runs.get(runId);
  }

  /**
   * Every non-terminal run assigned to this runner. Reconciliation is scoped by
   * it: one runner reconnecting must not disturb another's work.
   */
  runsFor(runnerId: string): Run[] {
    return [...this.#runs.values()].filter(
      (run) =>
        run.runnerId === runnerId &&
        !(run.observedState && TERMINAL_OBSERVED.has(run.observedState)),
    );
  }

  requestCancel(runId: string): void {
    const run = this.#runs.get(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    // Only the desired state moves. The UI shows "cancel requested" alongside
    // whatever the runner last observed (§11.2).
    run.cancelRequested = true;
    if (ACTIVE_DESIRED.has(run.desiredState)) {
      run.desiredState = "running";
    }
  }

  /**
   * The runner's gate parked on a tool permission or a user question (§13).
   * The work is not gone — it cannot be resumed, cancelled mid-gate, or
   * double-run — but it is no longer making progress, and both the reconcile
   * inventory and the operator's view should say so.
   *
   * A late request for a finished run is ignored: terminal observations are
   * never retracted (§22.2).
   */
  markWaitingForApproval(runId: string, attemptId: string): void {
    const run = this.#current(runId, attemptId);
    if (!run) return;
    if (run.observedState && TERMINAL_OBSERVED.has(run.observedState)) return;
    run.observedState = "waiting_for_approval";
  }

  /** The gate resolved; the attempt is making progress again. */
  markApprovalResolved(runId: string, attemptId: string): void {
    const run = this.#current(runId, attemptId);
    if (run?.observedState !== "waiting_for_approval") return;
    run.observedState = "running";
  }

  apply(action: ReconcileAction): void {
    switch (action.kind) {
      case "quarantine": {
        this.#quarantined.push({
          runId: action.runId,
          attemptId: action.attemptId,
          reason: action.reason,
        });
        return;
      }

      case "adopt_terminal": {
        const run = this.#current(action.runId, action.attemptId);
        if (!run) return;
        if (run.observedState && TERMINAL_OBSERVED.has(run.observedState)) return; // idempotent
        run.observedState = action.state;
        run.desiredState =
          action.state === "completed"
            ? "completed"
            : action.state === "failed"
              ? "failed"
              : "cancelled";
        return;
      }

      case "mark_interrupted": {
        const run = this.#current(action.runId, action.attemptId);
        if (!run) return;
        // Never overwrite a known terminal outcome with an interruption.
        if (run.observedState && TERMINAL_OBSERVED.has(run.observedState)) return;
        run.observedState = "interrupted";
        run.desiredState = "interrupted";
        return;
      }

      // The remaining actions describe facts the server records elsewhere
      // (command receipts, audit, evidence). They do not change run state.
      default:
        return;
    }
  }

  quarantined(): Array<{ runId: string; attemptId: string; reason: "no_assignment" }> {
    return [...this.#quarantined];
  }

  activeRunFor(sessionId: string): Run | undefined {
    for (const run of this.#runs.values()) {
      if (run.sessionId !== sessionId) continue;
      // A run is active while its *observed* state is not terminal. A pending
      // cancel does not free the session — the work may still be running.
      if (run.observedState && TERMINAL_OBSERVED.has(run.observedState)) continue;
      return run;
    }
    return undefined;
  }

  /** The run, only if the action refers to its current attempt. */
  #current(runId: string, attemptId: string): Run | undefined {
    const run = this.#runs.get(runId);
    if (!run || run.attemptId !== attemptId) return undefined;
    return run;
  }
}

/** Structural type guard used by reconcile callers passing registry state back in. */
export function toServerRunState(run: Run): {
  runId: string;
  attemptId: string;
  state: RunState;
  cancelRequested: boolean;
} {
  return {
    runId: run.runId,
    attemptId: run.attemptId,
    state: run.observedState ?? (run.desiredState === "queued" ? "queued" : "running"),
    cancelRequested: run.cancelRequested,
  };
}
