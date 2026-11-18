import type { Database } from "bun:sqlite";
import {
  appendServerEvent,
  type CommandOutbox,
  type RunnerCapacity,
  reopenRejectedSchedule,
  type Scheduler,
} from "@cc-web/control-db";
import type { BrowserReplayEvent } from "@cc-web/protocol";

const TRANSIENT_REASONS = new Set(["workspace_busy", "draining"]);

export type RequeuePublish = (event: { sessionId: string } & BrowserReplayEvent) => void;

export type HandleRejectedStartInput = {
  db: Database;
  outbox: CommandOutbox;
  scheduler: Scheduler;
  capacityOf: (runnerId: string) => RunnerCapacity;
  publish?: RequeuePublish;
  runId: string;
  commandId: string;
  reason: string;
  now?: number;
};

export function handleRejectedStart(
  input: HandleRejectedStartInput,
): "requeued" | "abandoned" | "rejected" {
  const { db, outbox, scheduler, capacityOf, publish, runId, commandId, reason, now } = input;

  const row = outbox.get(commandId);

  const promote = (runnerId: string | undefined): void => {
    if (runnerId !== undefined) {
      scheduler.promote(runnerId, capacityOf(runnerId));
    }
  };

  if (row === undefined) {
    promote(scheduler.release(runId));
    return "rejected";
  }

  if (!TRANSIENT_REASONS.has(reason)) {
    const freed = scheduler.release(runId);
    reopenRejectedSchedule(db, outbox, { commandId, runId });
    promote(freed ?? row.runnerId);
    return "rejected";
  }

  const freedRunnerId = scheduler.release(runId);
  const promoteRunnerId = freedRunnerId ?? row.runnerId;

  if (row.deliveryState !== "rejected") {
    promote(promoteRunnerId);
    return "requeued";
  }

  const requeueResult = outbox.requeue(commandId);
  if (requeueResult === "requeued") {
    promote(promoteRunnerId);
    return "requeued";
  }

  if (requeueResult === "ceiling") {
    const abandonRow = outbox.get(commandId) ?? row;
    // Every `run.start` row the scheduler writes carries its session and
    // attempt (§11.1): `dispatch` passes both from a request whose fields are
    // required, so these fallbacks cannot be reached from a real rejection.
    // They exist because `OutboxCommand` types the columns as optional (the
    // table allows null for other kinds). The branch is kept rather than
    // asserted so a future enqueue site that omits them degrades to retiring
    // the row instead of throwing inside the rejection path.
    const sessionId = abandonRow.sessionId ?? row.sessionId;
    const attemptId = abandonRow.attemptId ?? row.attemptId;
    const eventRunId = abandonRow.runId ?? row.runId ?? runId;

    if (sessionId !== undefined && attemptId !== undefined) {
      const append = appendServerEvent(
        db,
        {
          runnerId: abandonRow.runnerId ?? row.runnerId,
          sessionId,
          runId: eventRunId,
          attemptId,
          type: "run.failed",
          payload: { reason: "queue_abandoned", detail: reason },
        },
        now === undefined ? {} : { now },
      );

      outbox.markRejected(commandId, "queue_abandoned");

      if (append.status === "stored" && append.sessionSequence !== undefined) {
        publish?.({
          sessionId: append.event.sessionId,
          sessionSequence: append.sessionSequence,
          eventId: append.event.eventId,
          runId: append.event.runId,
          attemptId: append.event.attemptId,
          occurredAt: append.event.occurredAt,
          type: "run.failed",
          payload: append.event.payload,
        });
      }
    } else {
      outbox.markRejected(commandId, "queue_abandoned");
    }
    promote(promoteRunnerId);
    return "abandoned";
  }

  // "not_rejected" - `requeue` only refuses a row that is not `rejected`, and
  // the check above proved it was. Unreachable from today's callers; treated
  // as already-requeued so a concurrent path that got there first is not
  // double-promoted into a second admission.
  promote(promoteRunnerId);
  return "requeued";
}
