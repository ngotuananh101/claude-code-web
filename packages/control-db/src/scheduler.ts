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

export class Scheduler {
  readonly #db: Database;
  readonly #outbox: CommandOutbox;

  constructor(db: Database) {
    this.#db = db;
    this.#outbox = new CommandOutbox(db);
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

    // The outbox computes the fingerprint, so it is the only writer of that
    // column. Doing it here instead would duplicate the canonicalisation and
    // let the two disagree.
    await this.#outbox.enqueue({
      commandId,
      runnerId: capacity.runnerId,
      kind: "run.start",
      issuedAt,
      payload: {
        sessionId: request.sessionId,
        runId: request.runId,
        attemptId: request.attemptId,
        workspaceId: request.workspaceId,
        prompt: request.prompt,
      },
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

    return { ok: true, runnerId: capacity.runnerId, commandId };
  }

  /** Frees the session and the runner slot once a run reaches a terminal state. */
  release(runId: string): void {
    this.#db.query("DELETE FROM active_runs WHERE run_id = ?").run(runId);
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
