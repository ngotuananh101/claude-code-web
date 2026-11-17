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
  if (row === undefined) {
    scheduler.release(runId);
    return "rejected";
  }

  if (!TRANSIENT_REASONS.has(reason)) {
    scheduler.release(runId);
    reopenRejectedSchedule(db, outbox, { commandId, runId });
    return "rejected";
  }

  if (row.deliveryState !== "rejected") {
    scheduler.release(runId);
    return "requeued";
  }

  const runnerId = row.runnerId;
  const freedRunnerId = scheduler.release(runId);
  const promoteRunnerId = freedRunnerId ?? runnerId;

  const requeueResult = outbox.requeue(commandId);
  if (requeueResult === "requeued") {
    scheduler.promote(promoteRunnerId, capacityOf(promoteRunnerId));
    return "requeued";
  }

  if (requeueResult === "ceiling") {
    const abandonRow = outbox.get(commandId) ?? row;
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
    return "abandoned";
  }

  // "not_rejected" - command no longer in the expected state; avoid double work.
  return "requeued";
}
