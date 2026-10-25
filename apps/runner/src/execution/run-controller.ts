/**
 * The seam between the inbox and the executor (§9.3, §10.1).
 *
 * `handleCommand` answers the receipt. This module decides what happens next,
 * and it is the only place where the two facts that make execution safe meet:
 * the inbox says "first delivery", and the attempt table says "workspace free".
 * Splitting those across call sites is how a delivery eventually gets run twice.
 *
 * Shutdown is explicit. A fire-and-forget `void executeRun(...)` would let
 * `stop()` close the database underneath a run that is still writing events, so
 * every in-flight run is tracked and `settle()` waits for them.
 */

import type { Database } from "bun:sqlite";
import {
  acceptCommand,
  beginAttempt,
  type CommandEnvelope,
  finishAttempt,
  pendingApproval,
  recoverStaleAttempts,
  releaseAttempt,
} from "@cc-web/runner-db";
import type { RunnerInventoryItem } from "../connection/reconnect-loop.ts";
import { ApprovalRouter } from "./approvals.ts";
import { asCommandEnvelope, commandIdOf } from "./envelope.ts";
import { executeRun, type SdkStream } from "./executor.ts";

export type CommandReceipt = {
  commandId: string;
  attemptId: string;
  accepted: boolean;
  reason?: string;
};

export type ControllerOptions = {
  db: Database;
  localRunnerId: string;
  /** Resolves a workspace id to its canonical path, or undefined if unregistered. */
  workspacePathFor: (workspaceId: string) => string | undefined;
  sdk: SdkStream;
  /** Injected clock, so expiry is testable without waiting for it. */
  now?: () => number;
  /**
   * Called once per attempt after its run settles, whatever the outcome. The
   * event pump uses it as its "this attempt's rows are complete" trigger —
   * the controller itself knows nothing about a socket.
   */
  onSettled?: (attemptId: string) => void;
  /**
   * Called after every `approval.*` append (§13). A suspended run never
   * settles, so the pump cannot wait for `onSettled` to learn that a decision
   * is being waited on — the gate triggers the flush itself.
   */
  onApprovalEvent?: () => void;
};

/** One tracked run: what shutdown or cancel needs to reach it. */
type InFlightRun = {
  attemptId: string;
  runId: string;
  controller: AbortController;
  promise: Promise<void>;
};

export class RunController {
  readonly #db: Database;
  readonly #localRunnerId: string;
  readonly #workspacePathFor: (workspaceId: string) => string | undefined;
  readonly #sdk: SdkStream;
  readonly #now: () => number;
  readonly #onSettled: ((attemptId: string) => void) | undefined;
  readonly #onApprovalEvent: (() => void) | undefined;

  /** Every run in flight, keyed by attempt id, so shutdown can wait or cancel. */
  readonly #inFlight = new Map<string, InFlightRun>();

  /** The attempt's approval gate (§13), registered while its run is in flight. */
  readonly #routers = new Map<string, ApprovalRouter>();

  /** Set the moment draining begins; a draining runner accepts no new work. */
  #draining = false;

  constructor(options: ControllerOptions) {
    this.#db = options.db;
    this.#localRunnerId = options.localRunnerId;
    this.#workspacePathFor = options.workspacePathFor;
    this.#sdk = options.sdk;
    this.#now = options.now ?? Date.now;
    this.#onSettled = options.onSettled;
    this.#onApprovalEvent = options.onApprovalEvent;

    // §9.7: whatever was in flight when the previous process died is
    // interrupted, not resumed. Doing it here means it happens before the first
    // command can be accepted, not some time later.
    recoverStaleAttempts(this.#db);

    // §13: nothing is in flight yet, so every pending approval belongs to an
    // attempt this process just interrupted. Finished expired IN PLACE, with no
    // fabricated event — the dead attempt's stream is complete (§18.3) and
    // reconciliation marks those runs interrupted server-side. The per-attempt
    // timers and sweeps cover timeout from here on; no interval is needed.
    this.#db
      .prepare("UPDATE pending_approvals SET state = 'expired' WHERE state = 'pending'")
      .run();
  }

  async handle(command: unknown): Promise<CommandReceipt> {
    const parsed = asCommandEnvelope(command);
    if (parsed === undefined) {
      return {
        commandId: commandIdOf(command),
        attemptId: "",
        accepted: false,
        reason: "malformed",
      };
    }

    // §20.4: draining means no new accepts. Refused before the inbox persists
    // it, so the command stays the server's to redeliver after the restart —
    // not trusted to a process that is on its way out.
    if (this.#draining) {
      return {
        commandId: parsed.commandId,
        attemptId: parsed.attemptId ?? "",
        accepted: false,
        reason: "draining",
      };
    }

    const accepted = acceptCommand(this.#db, parsed, {
      localRunnerId: this.#localRunnerId,
      now: this.#now(),
    });
    if (!accepted.ok) {
      return {
        commandId: parsed.commandId,
        attemptId: parsed.attemptId ?? "",
        accepted: false,
        reason: accepted.reason,
      };
    }

    // A duplicate is already in the inbox and its work is running or done.
    // Answering from the stored state is the whole point (§9.3).
    if (accepted.duplicate) {
      return receipt(parsed, true);
    }

    // §14.2: a cancel is not a run. Persisted above like every command, it now
    // routes to the abort of the run it names — treating it as a start would
    // execute the cancel as a prompt against a locked workspace.
    if (parsed.kind === "run.cancel") {
      const target = this.#findByAttemptId(parsed.attemptId) ?? this.#findByRunId(parsed.runId);
      if (target !== undefined) target.controller.abort();
      return receipt(parsed, true);
    }

    // §13: a decision is not a run either. It routes to the gate of the attempt
    // that asked — found through the approval's own row, since the command's
    // envelope names the session, not the gate — and its refusal, if any, is
    // carried as the receipt's reason while the receipt itself stays accepted:
    // the command was delivered and persisted; what failed is the decision.
    if (parsed.kind === "approval.respond") {
      const payload = (parsed.payload ?? {}) as Record<string, unknown>;
      const approvalId = typeof payload["approvalId"] === "string" ? payload["approvalId"] : "";
      const row = pendingApproval(this.#db, approvalId);
      const attemptId =
        typeof parsed.attemptId === "string" && parsed.attemptId !== ""
          ? parsed.attemptId
          : (row?.attemptId ?? "");
      const router =
        this.#routers.get(attemptId) ?? new ApprovalRouter({ db: this.#db, append: () => {} });
      const result = router.respond(
        {
          approvalId,
          decision: payload["decision"],
          answers: payload["answers"],
          inputHash: payload["inputHash"],
        },
        { attemptId, runId: parsed.runId ?? "" },
      );
      return result.ok
        ? receipt(parsed, true)
        : { ...receipt(parsed, true), reason: result.reason };
    }

    const attemptId = parsed.attemptId ?? parsed.commandId;
    const workspacePath =
      parsed.workspaceId === undefined ? undefined : this.#workspacePathFor(parsed.workspaceId);

    if (workspacePath === undefined) {
      // Refusing here — before an attempt row exists — leaves nothing for
      // reconciliation to explain. The command stays accepted in the inbox,
      // which is honest: it was delivered, it just cannot run on this host.
      return { ...receipt(parsed, false), reason: "unknown_workspace" };
    }

    const begun = beginAttempt(this.#db, {
      attemptId,
      sessionId: parsed.sessionId ?? "",
      runId: parsed.runId ?? "",
      workspacePath,
      now: this.#now(),
    });

    if (!begun.ok) {
      return {
        ...receipt(parsed, false),
        reason: begun.reason === "workspace_locked" ? "workspace_busy" : "attempt_exists",
      };
    }

    // The attempt is recorded, so the run is now this process's responsibility.
    // Tracked rather than awaited: the receipt must not wait for a run that can
    // take minutes (§9.4 — accepted is not started). The controller keeps the
    // abort handle so a later cancel or shutdown can reach the live run (§14.2,
    // §20.4).
    const controller = new AbortController();
    const run: InFlightRun = {
      attemptId,
      runId: parsed.runId ?? "",
      controller,
      promise: executeRun(this.#db, parsed, {
        workspacePath,
        sdk: this.#sdk,
        signal: controller.signal,
        router: (append, attempt) => {
          const router = new ApprovalRouter({ db: this.#db, append, now: this.#now });
          this.#routers.set(attempt, router);
          return router;
        },
        onApprovalEvent: () => this.#onApprovalEvent?.(),
      })
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          this.#inFlight.delete(attemptId);
          this.#routers.delete(attemptId);
          // Fired after the delete so a synchronous trigger observes a
          // controller that no longer counts this attempt. Advisory: a
          // throwing trigger must not reject the tracked promise, which
          // settle() awaits.
          try {
            this.#onSettled?.(attemptId);
          } catch {
            // The pump's problem, on the pump's next trigger.
          }
        }),
    };
    this.#inFlight.set(attemptId, run);

    return receipt(parsed, true);
  }

  /**
   * What reconciliation and the server's registry should believe is running
   * (§14.3): one row per in-flight attempt, `waiting_for_approval` while its
   * gate holds a pending row. The pending rows ARE the waiting truth — the
   * gate wrote them durably, so the report cannot drift from the gate.
   */
  inventory(): RunnerInventoryItem[] {
    return [...this.#inFlight.values()].map((run) => {
      // bun:sqlite answers null for "no row" — compared explicitly, because an
      // `!== undefined` check is always true and would report every run as
      // waiting forever.
      const waiting =
        this.#db
          .prepare(
            "SELECT 1 FROM pending_approvals WHERE attempt_id = ? AND state = 'pending' LIMIT 1",
          )
          .get(run.attemptId) !== null;
      return {
        runId: run.runId,
        attemptId: run.attemptId,
        state: waiting ? "waiting_for_approval" : "running",
        processAlive: true,
        approvalsAlive: waiting,
      };
    });
  }

  /** Resolves when no run is in flight. Used before closing the database. */
  async settle(): Promise<void> {
    // A run can finish and release another; follow the set until it is empty.
    while (this.#inFlight.size > 0) {
      await Promise.all([...this.#inFlight.values()].map((run) => run.promise));
    }
  }

  /**
   * Draining shutdown (§20.4): bounded, unlike `settle()`.
   *
   * In-flight runs get a grace period to finish on their own; whatever is still
   * going is then cancelled deliberately — the abort makes a live SDK stream
   * throw within seconds, and the executor records that as `interrupted`. A run
   * that survives even its own abort (a wedged subprocess) gets the same verdict
   * a crash would (§9.7): written here as `interrupted` with the lock released,
   * so the database is truthful now rather than after the next boot's sweep.
   * `finishAttempt` is write-once (§22.2) — if such a run somehow settles later,
   * its own terminal write refuses to overwrite this one.
   */
  async drain(options: { graceMs: number }): Promise<{ abandoned: string[] }> {
    this.#draining = true;
    const sleep = (ms: number) => Bun.sleep(ms);

    if (this.#inFlight.size > 0) {
      await Promise.race([this.settle(), sleep(options.graceMs)]);
    }

    if (this.#inFlight.size > 0) {
      for (const run of this.#inFlight.values()) run.controller.abort();
      await Promise.race([this.settle(), sleep(options.graceMs)]);
    }

    const abandoned: string[] = [];
    for (const run of this.#inFlight.values()) {
      finishAttempt(this.#db, { attemptId: run.attemptId, state: "interrupted" });
      releaseAttempt(this.#db, run.attemptId);
      abandoned.push(run.attemptId);
    }
    return { abandoned };
  }

  #findByAttemptId(attemptId: string | undefined): InFlightRun | undefined {
    return attemptId === undefined ? undefined : this.#inFlight.get(attemptId);
  }

  #findByRunId(runId: string | undefined): InFlightRun | undefined {
    if (runId === undefined) return undefined;
    for (const run of this.#inFlight.values()) {
      if (run.runId === runId) return run;
    }
    return undefined;
  }
}

function receipt(command: CommandEnvelope, accepted: boolean): CommandReceipt {
  return {
    commandId: command.commandId,
    attemptId: command.attemptId ?? "",
    accepted,
  };
}
