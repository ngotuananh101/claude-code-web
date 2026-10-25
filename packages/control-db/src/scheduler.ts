/**
 * Scheduling MVP (§11.3).
 *
 * The user picks a workspace already bound to a Runner; this decides whether
 * that Runner can take the run, and if so writes the command to the outbox.
 *
 * Deliberately small. §11.3 rules out smart placement and a worker pool, and
 * the interesting behaviour is all in the refusals:
 *
 *  - `connected` is not `ready`: a runner that has not reconciled may hold
 *    state the server does not know about (§6.2)
 *  - a runner at capacity is refused, not queued — the Runner has its own local
 *    queue, and a second one here would double-count
 *  - one active run per session (§2.3)
 *
 * Dispatch and enqueue happen together. A decision the outbox never hears about
 * is a run the operator believes was started.
 */

import type { Database } from "bun:sqlite";
import { CommandOutbox } from "./command-outbox.ts";
import { ensureSessionPin } from "./sessions.ts";

export type RunnerState = "offline" | "connected" | "ready" | "draining" | "revoked";

export type RunnerCapacity = {
  runnerId: string;
  state: RunnerState;
  maxConcurrentRuns: number;
  activeRuns: number;
};

export type DispatchRequest = {
  sessionId: string;
  runId: string;
  attemptId: string;
  workspaceId: string;
  prompt: string;
  /**
   * The session's owner (§2.3). Recorded on the pin so the dispatch route can
   * answer another user's reuse of the session id with 404 — no existence
   * leak — instead of dispatching into someone else's session.
   */
  ownerId: string;
  /**
   * The SDK permission mode the operator picked (§13). Validated by the route;
   * absent means the runner's own default. It rides the run.start payload so
   * the runner's executor can pass it to the SDK stream.
   */
  permissionMode?: string;
  /**
   * The model the operator picked for this run (§5.2). Validated by the route;
   * absent means the SDK's own default — the option is omitted, never set to a
   * stand-in value.
   */
  model?: string;
  /**
   * The git branch the operator picked for this run (M4). Validated by the
   * route against the runner's declaration; absent means no checkout — the
   * workspace stays on whatever HEAD it is on. Rides the payload next to
   * `model`, never as an envelope field.
   */
  branch?: string;
};

export type DispatchDecision =
  | { ok: true; runnerId: string; commandId: string }
  | {
      ok: false;
      reason:
        | "runner_offline"
        | "runner_not_ready"
        | "runner_at_capacity"
        | "session_busy"
        | "duplicate_run";
    };

type ActiveRow = { run_id: string; session_id: string; runner_id: string };

/** Told after a successful dispatch, so delivery happens as part of the call. */
export type DispatchListener = (runnerId: string, commandId: string) => void;

export class Scheduler {
  readonly #db: Database;
  readonly #outbox: CommandOutbox;
  readonly #onDispatched: DispatchListener | undefined;

  constructor(db: Database, options: { onDispatched?: DispatchListener } = {}) {
    this.#db = db;
    this.#outbox = new CommandOutbox(db);
    this.#onDispatched = options.onDispatched;
  }

  async dispatch(request: DispatchRequest, capacity: RunnerCapacity): Promise<DispatchDecision> {
    if (capacity.state === "offline" || capacity.state === "revoked") {
      return { ok: false, reason: "runner_offline" };
    }
    if (capacity.state !== "ready") {
      return { ok: false, reason: "runner_not_ready" };
    }
    if (capacity.maxConcurrentRuns <= 0 || capacity.activeRuns >= capacity.maxConcurrentRuns) {
      return { ok: false, reason: "runner_at_capacity" };
    }

    const existingRun = this.#db
      .query("SELECT run_id FROM active_runs WHERE run_id = ?")
      .get(request.runId) as { run_id: string } | null;
    if (existingRun) {
      // A retry of the same dispatch. Creating a second command under the same
      // run id would deliver the work twice.
      return { ok: false, reason: "duplicate_run" };
    }

    if (this.activeRunFor(request.sessionId)) {
      return { ok: false, reason: "session_busy" };
    }

    const commandId = `cmd_${crypto.randomUUID()}`;
    const issuedAt = new Date().toISOString();

    // Enqueue carries the envelope fields, not just the payload: the dispatcher
    // rebuilds the frame from the stored row alone, and a missing `sessionId`
    // would leave the runner unable to attribute the work.
    await this.#outbox.enqueue({
      commandId,
      runnerId: capacity.runnerId,
      kind: "run.start",
      issuedAt,
      sessionId: request.sessionId,
      runId: request.runId,
      attemptId: request.attemptId,
      workspaceId: request.workspaceId,
      payload: {
        sessionId: request.sessionId,
        runId: request.runId,
        attemptId: request.attemptId,
        workspaceId: request.workspaceId,
        prompt: request.prompt,
        ...(request.permissionMode === undefined ? {} : { permissionMode: request.permissionMode }),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.branch === undefined ? {} : { branch: request.branch }),
      },
    });

    // The pin is written only for an accepted dispatch — a refusal must never
    // relocate a session — and here, after the awaited enqueue and in the same
    // synchronous continuation as the active_runs insert, on purpose: the
    // enqueue hashes asynchronously, so a pin written earlier could survive on
    // a concurrent dispatch that then lost the session-busy insert race. From
    // this point the pin writer and the insert winner are the same dispatch by
    // construction. A crash between pin and insert leaves a pinned session
    // with an enqueued command and no active row — a retry passes every gate
    // (duplicate_run reads active_runs) and lands in its own pin.
    ensureSessionPin(this.#db, {
      sessionId: request.sessionId,
      ownerId: request.ownerId,
      workspaceId: request.workspaceId,
      runnerId: capacity.runnerId,
    });

    try {
      this.#db
        .query(
          `INSERT INTO active_runs (run_id, session_id, runner_id, attempt_id, dispatched_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(request.runId, request.sessionId, capacity.runnerId, request.attemptId, Date.now());
    } catch (error) {
      // The unique index caught a race between two dispatchers. Retire the
      // command we just wrote rather than leaving an orphan that would run.
      this.#outbox.markRejected(commandId, "session_busy");
      if (String(error).includes("UNIQUE")) {
        return { ok: false, reason: "session_busy" };
      }
      throw error;
    }

    // Delivery is part of dispatch. A caller that has to remember a second call
    // is a caller that will eventually forget it, and the run then sits in the
    // outbox until the runner happens to reconnect.
    this.#onDispatched?.(capacity.runnerId, commandId);

    return { ok: true, runnerId: capacity.runnerId, commandId };
  }

  /** Frees the session and the runner slot once a run reaches a terminal state. */
  release(runId: string): void {
    this.#db.query("DELETE FROM active_runs WHERE run_id = ?").run(runId);
  }

  /**
   * A durable cancel for an active run (§14.2).
   *
   * Enqueued like a start, so it inherits the same delivery guarantees: if the
   * runner is away, the cancel waits in the outbox and goes out on reconnect.
   * The active run is deliberately untouched — a cancel is a request, not an
   * outcome, and the slot frees only when the terminal event arrives. Releasing
   * here instead would let a lost cancel wedge a second run onto a workspace
   * the first run is still holding.
   */
  async cancel(
    runId: string,
  ): Promise<{ ok: true; commandId: string } | { ok: false; reason: "unknown_run" }> {
    const row = this.#db
      .query("SELECT session_id, runner_id, attempt_id FROM active_runs WHERE run_id = ?")
      .get(runId) as { session_id: string; runner_id: string; attempt_id: string } | null;
    if (row === null) return { ok: false, reason: "unknown_run" };

    const commandId = `cmd_${crypto.randomUUID()}`;
    await this.#outbox.enqueue({
      commandId,
      runnerId: row.runner_id,
      kind: "run.cancel",
      issuedAt: new Date().toISOString(),
      sessionId: row.session_id,
      runId,
      attemptId: row.attempt_id,
      payload: {},
    });

    this.#onDispatched?.(row.runner_id, commandId);
    return { ok: true, commandId };
  }

  activeRunFor(sessionId: string): { runId: string; runnerId: string } | undefined {
    const row = this.#db
      .query("SELECT run_id, runner_id FROM active_runs WHERE session_id = ?")
      .get(sessionId) as ActiveRow | null;
    return row ? { runId: row.run_id, runnerId: row.runner_id } : undefined;
  }

  capacityFor(runnerId: string, base: RunnerCapacity): RunnerCapacity {
    const row = this.#db
      .query("SELECT COUNT(*) AS n FROM active_runs WHERE runner_id = ?")
      .get(runnerId) as { n: number };
    return { ...base, activeRuns: row.n };
  }
}
