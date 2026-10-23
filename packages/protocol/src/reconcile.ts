/**
 * Reconciliation (§14.3, §14.4).
 *
 * Called when a Runner reconnects, before it is promoted to `ready`. It compares
 * what the server believes with what the Runner observes, and emits actions for
 * the server to apply.
 *
 * The one rule that shapes every branch: **reconciliation never creates an
 * execution attempt.** It observes, records and quarantines. If a run's outcome
 * cannot be determined, the honest answer is `interrupted`, not a retry —
 * §9.7 and §14.4 both require the ambiguous case to stay visible rather than be
 * silently re-run.
 *
 * This module is pure: no database, no clock, no I/O. The caller applies the
 * actions inside its own transaction.
 */

export type RunState =
  | "queued"
  | "accepted"
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  /**
   * The process is gone without a terminal outcome. Distinct from `failed`
   * because it is an absence of knowledge, not a known error (§9.7).
   */
  | "interrupted"
  | "unknown";

export type ServerRunState = {
  runId: string;
  attemptId: string;
  state: RunState;
  /** Desired-state flag; may be set while the observed run is still alive (§11.2). */
  cancelRequested: boolean;
  /**
   * ID of the cancel command already persisted for this attempt. Required when
   * `cancelRequested` is set: §14.2 requires the *same* ID to be re-sent, so
   * the server's stored ID is the only correct source.
   */
  cancelCommandId?: string;
  attemptEpoch?: number;
};

export type RunnerRunState = {
  runId: string;
  attemptId: string;
  state: RunState;
  /** Whether the runner can prove a live process for this attempt. */
  processAlive?: boolean;
  /** False when the callback behind a pending approval no longer exists. */
  approvalsAlive?: boolean;
  /** Present when the runner accepted the corresponding command. */
  commandReceiptId?: string;
};

export type ReconcileAction =
  | { kind: "record_receipt"; runId: string; attemptId: string; commandId: string }
  | {
      kind: "adopt_terminal";
      runId: string;
      attemptId: string;
      state: "completed" | "failed" | "cancelled";
    }
  | { kind: "continue_observing"; runId: string; attemptId: string }
  | { kind: "mark_interrupted"; runId: string; attemptId: string }
  | { kind: "quarantine"; runId: string; attemptId: string; reason: "no_assignment" }
  | { kind: "resend_cancel"; runId: string; attemptId: string; commandId: string }
  | { kind: "abandon_approval"; runId: string; attemptId: string }
  | { kind: "record_stale_evidence"; runId: string; attemptId: string }
  | { kind: "audit"; detail: string; runId: string; attemptId: string };

export type ReconcileResult = {
  ready: boolean;
  blockedReason?: "contradictory_inventory";
  actions: ReconcileAction[];
};

const TERMINAL: ReadonlySet<RunState> = new Set(["completed", "failed", "cancelled"]);

export function reconcile(input: {
  server: ServerRunState[];
  runner: RunnerRunState[];
}): ReconcileResult {
  const actions: ReconcileAction[] = [];

  // Group runner reports by attempt so contradictions are visible rather than
  // resolved by whichever entry happens to be last.
  const runnerByAttempt = new Map<string, RunnerRunState[]>();
  for (const report of input.runner) {
    const list = runnerByAttempt.get(report.attemptId) ?? [];
    list.push(report);
    runnerByAttempt.set(report.attemptId, list);
  }

  for (const reports of runnerByAttempt.values()) {
    if (reports.length > 1 && isContradictory(reports)) {
      // Two irreconcilable claims about one attempt. Guessing which is true would
      // put the server into a state neither side can vouch for.
      return { ready: false, blockedReason: "contradictory_inventory", actions: [] };
    }
  }

  const serverByAttempt = new Map(input.server.map((s) => [s.attemptId, s]));

  for (const serverRun of input.server) {
    const reports = runnerByAttempt.get(serverRun.attemptId) ?? [];
    const report = reports[0];

    if (!report) {
      // In flight on the server, invisible to the runner. The process is gone
      // without a terminal outcome; do not resume it.
      if (!TERMINAL.has(serverRun.state)) {
        actions.push({
          kind: "mark_interrupted",
          runId: serverRun.runId,
          attemptId: serverRun.attemptId,
        });
      }
      continue;
    }

    if (TERMINAL.has(report.state)) {
      actions.push({
        kind: "adopt_terminal",
        runId: serverRun.runId,
        attemptId: serverRun.attemptId,
        state: report.state as "completed" | "failed" | "cancelled",
      });

      // A cancel that arrived after the run finished describes the past. Record
      // it, but never rewrite the real outcome as cancelled (§14.2).
      if (serverRun.cancelRequested) {
        actions.push({
          kind: "audit",
          detail: "cancel_too_late",
          runId: serverRun.runId,
          attemptId: serverRun.attemptId,
        });
      }
      continue;
    }

    // Approval handling comes before process state: a run can be alive while its
    // approval callback is dead, and that combination needs its own action.
    if (serverRun.state === "waiting_for_approval" && report.approvalsAlive === false) {
      actions.push({
        kind: "abandon_approval",
        runId: serverRun.runId,
        attemptId: serverRun.attemptId,
      });
      actions.push({
        kind: "mark_interrupted",
        runId: serverRun.runId,
        attemptId: serverRun.attemptId,
      });
      continue;
    }

    if (report.processAlive === true) {
      if (serverRun.cancelRequested && serverRun.cancelCommandId) {
        actions.push({
          kind: "resend_cancel",
          runId: serverRun.runId,
          attemptId: serverRun.attemptId,
          commandId: serverRun.cancelCommandId,
        });
      } else if (serverRun.cancelRequested) {
        // A cancel was requested but never persisted with an ID. Re-issuing under
        // a fresh ID would create a second cancel command; record the gap instead.
        actions.push({
          kind: "audit",
          detail: "cancel_command_missing",
          runId: serverRun.runId,
          attemptId: serverRun.attemptId,
        });
        actions.push({
          kind: "continue_observing",
          runId: serverRun.runId,
          attemptId: serverRun.attemptId,
        });
      } else {
        actions.push({
          kind: "continue_observing",
          runId: serverRun.runId,
          attemptId: serverRun.attemptId,
        });
      }
      continue;
    }

    if (report.state === "accepted" && report.commandReceiptId) {
      // Delivered but not started. Record that fact; do not start it here.
      actions.push({
        kind: "record_receipt",
        runId: serverRun.runId,
        attemptId: serverRun.attemptId,
        commandId: report.commandReceiptId,
      });
      continue;
    }

    if (report.state === "unknown" && report.processAlive === false) {
      actions.push({
        kind: "mark_interrupted",
        runId: serverRun.runId,
        attemptId: serverRun.attemptId,
      });
      continue;
    }

    // Anything else the runner reports about its own attempt without a live
    // process is still not proof of death. Keep observing rather than guessing.
    actions.push({
      kind: "continue_observing",
      runId: serverRun.runId,
      attemptId: serverRun.attemptId,
    });
  }

  for (const run of input.runner) {
    if (serverByAttempt.has(run.attemptId)) continue;

    // The runner holds a process the server never assigned. This is the identity
    // clone / stale-assignment case: keep it as evidence, never attach it to a
    // session (§14.4 row 5).
    actions.push({
      kind: "quarantine",
      runId: run.runId,
      attemptId: run.attemptId,
      reason: "no_assignment",
    });
  }

  // A late report for a superseded attempt of a run the server has since
  // reassigned is evidence only; it must not seize the current assignment.
  for (const serverRun of input.server) {
    const staleAttempts = input.runner.filter(
      (r) => r.runId === serverRun.runId && r.attemptId !== serverRun.attemptId,
    );
    for (const stale of staleAttempts) {
      actions.push({
        kind: "record_stale_evidence",
        runId: stale.runId,
        attemptId: stale.attemptId,
      });
    }
  }

  return { ready: true, actions: dedupe(actions) };
}

function isContradictory(reports: RunnerRunState[]): boolean {
  const anyTerminal = reports.some((r) => TERMINAL.has(r.state));
  const anyAlive = reports.some((r) => r.processAlive === true && !TERMINAL.has(r.state));
  return anyTerminal && anyAlive;
}

function dedupe(actions: ReconcileAction[]): ReconcileAction[] {
  const seen = new Set<string>();
  const result: ReconcileAction[] = [];
  for (const action of actions) {
    const key = `${action.kind}:${action.runId}:${action.attemptId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(action);
  }
  return result;
}
