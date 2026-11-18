import type { Database } from "bun:sqlite";
import type { ServerRunState } from "@cc-web/protocol";

/**
 * The server's durable inventory for reconciliation (§14.3).
 *
 * `active_runs` is where a run slot actually lives: scheduler capacity, the
 * session-busy check and the workspace-busy check all read it. The in-memory
 * `RunRegistry` does not survive a control-server restart and, in production,
 * is never populated at all — so reconciliation reading it saw an empty
 * inventory and could not release a crashed run's slot. This module is the
 * durable answer: every run assigned to a runner and not yet terminalized.
 *
 * Two facts are projected from other tables, because a bare row cannot answer
 * them and the reconcile function branches on both:
 *
 *  - `state`: a run with an `active_runs` row has been dispatched and not
 *    terminalized, so it is `running` — unless a pending `approvals` row says
 *    its gate is parked, in which case `waiting_for_approval` is what makes the
 *    crash-parked-on-a-gate branch (abandon + interrupt) reachable.
 *  - `cancelRequested` / `cancelCommandId`: §14.2 requires a re-sent cancel to
 *    carry the *same* command id, so the id comes from the outbox row, never
 *    from a fresh one.
 *
 * No `attemptEpoch`: nothing durable records one, and inventing it here would
 * make reconciliation compare against a number neither side chose.
 */

type InventoryRow = {
  run_id: string;
  attempt_id: string;
  awaiting_approval: number;
  cancel_command_id: string | null;
};

/**
 * Every non-terminal run assigned to `runnerId`, oldest dispatch first.
 *
 * Scoped by runner: reconciliation is per connection, and one runner
 * reconnecting must not disturb another's work.
 */
export function serverRunsForRunner(db: Database, runnerId: string): ServerRunState[] {
  const rows = db
    .prepare(
      `SELECT a.run_id,
              a.attempt_id,
              EXISTS (
                SELECT 1 FROM approvals ap
                 WHERE ap.attempt_id = a.attempt_id AND ap.state = 'pending'
              ) AS awaiting_approval,
              (
                SELECT c.command_id FROM command_outbox c
                 WHERE c.run_id = a.run_id
                   AND c.kind = 'run.cancel'
                   AND c.delivery_state != 'rejected'
                 ORDER BY c.created_at DESC, c.command_id DESC
                 LIMIT 1
              ) AS cancel_command_id
         FROM active_runs a
        WHERE a.runner_id = ?
        ORDER BY a.dispatched_at ASC, a.run_id ASC`,
    )
    .all(runnerId) as InventoryRow[];

  return rows.map((row) => {
    const cancelCommandId = row.cancel_command_id ?? undefined;
    return {
      runId: row.run_id,
      attemptId: row.attempt_id,
      state: row.awaiting_approval === 1 ? "waiting_for_approval" : "running",
      cancelRequested: cancelCommandId !== undefined,
      ...(cancelCommandId === undefined ? {} : { cancelCommandId }),
    };
  });
}
