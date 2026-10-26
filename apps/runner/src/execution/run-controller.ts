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
import { type ExecuteOptions, executeRun, type SdkStream } from "./executor.ts";

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
  /**
   * The workspace-preparation gate (M4): threaded to every run under the
   * workspace lock it already holds. The daemon wires the branch checkout
   * gate; absent means nothing to prepare.
   */
  prepareWorkspace?: ExecuteOptions["prepareWorkspace"];
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
  readonly #prepareWorkspace: ExecuteOptions["prepareWorkspace"] | undefined;
  readonly #now: () => number;
  readonly #onSettled: ((attemptId: string) => void) | undefined;
  readonly #onApprovalEvent: (() => void) | undefined;

  /** Every run in flight, keyed by attempt id, so shutdown can wait or cancel. */
  readonly #inFlight = new Map<string, InFlightRun>();

  /** The attempt's approval gate (§13), registered while its run is in flight. */
  readonly #routers = new Map<string, ApprovalRouter>();

  /**
   * The attempt's own sequenced append, offered by the executor (§12.6) while
   * its run is in flight. This is how a spool warning gets journaled: the
   * executor owns the attempt's `local_sequence` space in a closure, so any
   * other writer would collide with it and leave a hole the ACK watermark
   * stops at (§12.2).
   */
  readonly #appends = new Map<string, (type: string, payload: unknown) => void>();

  /**
   * Why an attempt was stopped, for the stop that has a reason (§12.6). A
   * deliberate cancel leaves no entry, which is how the executor tells the two
   * apart and records `run.failed` for one and `run.interrupted` for the other.
   */
  readonly #cancelReasons = new Map<string, string>();

  /** Set the moment draining begins; a draining runner accepts no new work. */
  #draining = false;

  constructor(options: ControllerOptions) {
    this.#db = options.db;
    this.#localRunnerId = options.localRunnerId;
    this.#workspacePathFor = options.workspacePathFor;
    this.#sdk = options.sdk;
    this.#prepareWorkspace = options.prepareWorkspace;
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
      // No reason: a server-issued cancel is §14.2's deliberate stop, and the
      // executor records it as `interrupted`. Only a policy stop — the spool
      // critical threshold — has something to explain.
      if (target !== undefined) this.cancel(target.attemptId);
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
      // No router means no live gate: the run settled or the process restarted.
      // Resolving the row here — through a mute append — would flip it without
      // ever emitting approval.resolved, an audit trail nothing honors. Refuse
      // instead; the attempt's own sweep closes the row with its real terminal.
      const router = this.#routers.get(attemptId);
      if (router === undefined) {
        return { ...receipt(parsed, true), reason: "unknown" };
      }
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

    // Ruling 5: everything that is not a check is a start — but only `run.start`
    // earns that. Before this check the fall-through treated any unrecognised
    // kind as a run start, so a command this build does not implement (a newer
    // server's `workspace.inspect`, say) spawned a bogus SDK run and took the
    // workspace lock. The refusal names the kind, not the workspace, because
    // "I do not implement this" is true regardless of which workspace it names.
    if (parsed.kind !== "run.start") {
      return { ...receipt(parsed, false), reason: "unsupported_command" };
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
        ...(this.#prepareWorkspace === undefined
          ? {}
          : { prepareWorkspace: this.#prepareWorkspace }),
        signal: controller.signal,
        router: (append, attempt) => {
          const router = new ApprovalRouter({ db: this.#db, append, now: this.#now });
          this.#routers.set(attempt, router);
          return router;
        },
        onApprovalEvent: () => this.#onApprovalEvent?.(),
        // §12.6: the executor owns this attempt's sequence space, so it offers
        // the one closure anything else may journal through. Held only while
        // the run is in flight, like the router.
        onAppend: (append) => {
          this.#appends.set(attemptId, append);
        },
        // Read at abort time, not captured now: a cancel or a spool stop
        // arrives long after this construction.
        abortReason: () => this.#cancelReasons.get(attemptId),
      })
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          this.#inFlight.delete(attemptId);
          this.#routers.delete(attemptId);
          this.#appends.delete(attemptId);
          this.#cancelReasons.delete(attemptId);
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
   * Journal a spool warning for an attempt (§12.6).
   *
   * The row is written through the attempt's own append — the executor's, taken
   * when it offered the seam — because the attempt's `local_sequence` space has
   * exactly one writer. Writing a second row from here, at any sequence, either
   * collides with that writer or leaves a hole the ACK watermark stops at
   * (§12.2); both are transcript corruption, not a warning.
   *
   * False means there is no live run for the attempt: a spool report for an
   * attempt this process is not running has no sequence owner at all, so it can
   * only be logged, not journaled.
   */
  warnSpool(attemptId: string, info: { events: number; bytes: number }): boolean {
    const append = this.#appends.get(attemptId);
    if (append === undefined) return false;
    append("spool.warning", { events: info.events, bytes: info.bytes });
    return true;
  }

  /**
   * Stop a run and say why (§12.6, §14.2).
   *
   * The reason is recorded before the abort because the executor reads it at
   * abort time — when its stream dies and it decides between `run.failed` and
   * `run.interrupted`. A stop with no reason keeps §14.2's deliberate cancel
   * reading: interrupted, with nothing to explain.
   *
   * False means nothing was in flight under that attempt id — the run already
   * settled, and stopping it is not this call's problem.
   */
  cancel(attemptId: string, reason?: string): boolean {
    const target = this.#findByAttemptId(attemptId);
    if (target === undefined) return false;
    if (reason !== undefined && reason !== "") this.#cancelReasons.set(attemptId, reason);
    target.controller.abort();
    return true;
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
