import type { Database } from "bun:sqlite";
import {
  appendServerEvent,
  type ExpiredApproval,
  expirePendingApprovalsForAttempt,
} from "@cc-web/control-db";
import type { BrowserReplayEvent } from "@cc-web/protocol";

/**
 * Reconciliation's `abandon_approval`, made observable (§13.1, §14.3).
 *
 * The runner's gate is gone — crashed, or a restart that lost its inventory —
 * so no `approval.expired` will ever arrive from it. Closing the projection
 * rows alone leaves every open browser card interactive: the operator clicks
 * "Cho phép", the route answers that the row is not pending, and the card they
 * are looking at never changes until a reload.
 *
 * So the server emits the terminal itself: one journaled `approval.expired
 * {approvalId, reason: "abandoned"}` per closed row, broadcast like any other
 * event. The journal stays the single authority on outcomes (§13.2) — the card
 * turns read-only because a terminal event says so, not because the projection
 * happened to change.
 */

export type AbandonApprovalsInput = {
  db: Database;
  attemptId: string;
  /** The live browser fan-out; omitted in tests that only inspect the journal. */
  publish?: (event: { sessionId: string } & BrowserReplayEvent) => void;
  now?: number;
};

/**
 * Close the attempt's pending approvals and announce each one.
 *
 * Returns the approvals that were closed and journaled. A row the operator
 * already decided on is history and stays untouched — the caller only ever
 * announces what `expirePendingApprovalsForAttempt` actually closed.
 */
export function abandonAttemptApprovals(input: AbandonApprovalsInput): ExpiredApproval[] {
  const closed = expirePendingApprovalsForAttempt(input.db, input.attemptId);
  const announced: ExpiredApproval[] = [];

  for (const row of closed) {
    const append = appendServerEvent(
      input.db,
      {
        runnerId: row.runnerId,
        sessionId: row.sessionId,
        runId: row.runId,
        attemptId: row.attemptId,
        type: "approval.expired",
        payload: { approvalId: row.approvalId, reason: "abandoned" },
      },
      input.now === undefined ? {} : { now: input.now },
    );
    // A failed append must not take the others down with it: the projection is
    // already closed, and the next reconcile will not see these rows again.
    if (append.status !== "stored" || append.sessionSequence === undefined) continue;

    announced.push(row);
    input.publish?.({
      sessionId: row.sessionId,
      sessionSequence: append.sessionSequence,
      eventId: append.event.eventId,
      runId: append.event.runId,
      attemptId: append.event.attemptId,
      occurredAt: append.event.occurredAt,
      type: "approval.expired",
      payload: append.event.payload,
    });
  }

  return announced;
}
