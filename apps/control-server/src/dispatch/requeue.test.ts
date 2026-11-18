import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  CommandOutbox,
  ensureSessionPin,
  MAX_REQUEUES,
  migrate,
  Scheduler,
} from "@cc-web/control-db";
import { handleRejectedStart } from "./requeue.ts";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  ensureSessionPin(db, {
    sessionId: "session-1",
    ownerId: "user-1",
    workspaceId: "workspace-1",
    runnerId: "runner-a",
  });
  ensureSessionPin(db, {
    sessionId: "session-2",
    ownerId: "user-1",
    workspaceId: "workspace-2",
    runnerId: "runner-a",
  });

  const drained: string[] = [];
  const scheduler = new Scheduler(db, {
    onDispatched: (runnerId) => {
      drained.push(runnerId);
    },
  });
  const outbox = new CommandOutbox(db);

  const capacityOf = (runnerId: string) =>
    scheduler.capacityFor(runnerId, {
      runnerId,
      state: "ready",
      maxConcurrentRuns: 1,
      activeRuns: 0,
    });

  return { db, scheduler, outbox, drained, capacityOf };
}

async function dispatchAdmitted(
  scheduler: Scheduler,
  input: { sessionId: string; runId: string; attemptId: string; workspaceId: string },
) {
  const capacity = scheduler.capacityFor("runner-a", {
    runnerId: "runner-a",
    state: "ready",
    maxConcurrentRuns: 1,
    activeRuns: 0,
  });
  const decision = await scheduler.dispatch(
    {
      sessionId: input.sessionId,
      runId: input.runId,
      attemptId: input.attemptId,
      workspaceId: input.workspaceId,
      prompt: `prompt-${input.runId}`,
      ownerId: "user-1",
    },
    capacity,
    { queue: false },
  );
  if (!decision.ok || decision.queued) {
    throw new Error(`expected admitted dispatch, got ${JSON.stringify(decision)}`);
  }
  return decision.commandId;
}

async function dispatchQueued(
  scheduler: Scheduler,
  input: { sessionId: string; runId: string; attemptId: string; workspaceId: string },
) {
  const capacity = scheduler.capacityFor("runner-a", {
    runnerId: "runner-a",
    state: "ready",
    maxConcurrentRuns: 1,
    activeRuns: 0,
  });
  const decision = await scheduler.dispatch(
    {
      sessionId: input.sessionId,
      runId: input.runId,
      attemptId: input.attemptId,
      workspaceId: input.workspaceId,
      prompt: `prompt-${input.runId}`,
      ownerId: "user-1",
    },
    capacity,
  );
  if (!decision.ok || !decision.queued) {
    throw new Error(`expected queued dispatch, got ${JSON.stringify(decision)}`);
  }
  return decision.commandId;
}

describe("handleRejectedStart", () => {
  test("a transient rejection returns the command to the queue and promotes", async () => {
    const { db, scheduler, outbox, capacityOf } = setup();
    // run1 admitted (takes the only slot). run2 queued behind it on another session.
    const cmd1 = await dispatchAdmitted(scheduler, {
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      workspaceId: "workspace-1",
    });
    await dispatchQueued(scheduler, {
      sessionId: "session-2",
      runId: "run-2",
      attemptId: "attempt-2",
      workspaceId: "workspace-2",
    });
    // queuedFor orders by created_at then command_id. Both rows can share the
    // same millisecond, so force run-1 to be the FIFO head in this test only.
    const run1CreatedAt = (
      db.query("SELECT created_at FROM command_outbox WHERE run_id = 'run-1'").get() as {
        created_at: number;
      }
    ).created_at;
    db.query("UPDATE command_outbox SET created_at = ? WHERE run_id = 'run-2'").run(
      run1CreatedAt + 1000,
    );
    // Runner rejected run1's start: dispatcher marks the command rejected.
    outbox.markRejected(cmd1, "workspace_busy");

    const result = handleRejectedStart({
      db,
      outbox,
      scheduler,
      capacityOf,
      runId: "run-1",
      commandId: cmd1,
      reason: "workspace_busy",
    });

    expect(result).toBe("requeued");
    const row1 = outbox.get(cmd1);
    expect(row1?.requeueCount).toBe(1);
    // Released, requeued (count bumped), then promoted: run1 is the FIFO head
    // and eligible again, so promotion admits it; run2 remains queued.
    expect(scheduler.activeRunFor("session-1")?.runId).toBe("run-1");
    expect(row1?.deliveryState).toBe("pending");
    expect(scheduler.activeRunFor("session-2")).toBeUndefined();
    const queued2 = db
      .query("SELECT delivery_state FROM command_outbox WHERE run_id = 'run-2'")
      .get() as { delivery_state: string } | null;
    expect(queued2?.delivery_state).toBe("queued");
  });

  test("a permanent rejection retires the command and journals nothing", async () => {
    const { db, scheduler, outbox, capacityOf } = setup();
    const cmd1 = await dispatchAdmitted(scheduler, {
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      workspaceId: "workspace-1",
    });
    outbox.markRejected(cmd1, "unknown_workspace");

    const result = handleRejectedStart({
      db,
      outbox,
      scheduler,
      capacityOf,
      runId: "run-1",
      commandId: cmd1,
      reason: "unknown_workspace",
    });

    expect(result).toBe("rejected");
    expect(outbox.get(cmd1)?.deliveryState).toBe("rejected");
    const events = db.query("SELECT type, payload FROM run_events").all() as Array<{
      type: string;
      payload: string;
    }>;
    expect(events).toHaveLength(0);
    // Slot freed.
    expect(scheduler.activeRunFor("session-1")).toBeUndefined();
  });

  test("past the ceiling the server journals run.failed queue_abandoned and broadcasts it", async () => {
    const { db, scheduler, outbox, capacityOf } = setup();
    const cmd1 = await dispatchAdmitted(scheduler, {
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      workspaceId: "workspace-1",
    });
    // Drive requeue_count past the ceiling (> MAX_REQUEUES). markRejected + requeue
    // is the durable path that increments the count; stop when the next would be past.
    for (let i = 0; i <= MAX_REQUEUES; i++) {
      outbox.markRejected(cmd1, "draining");
      const r = outbox.requeue(cmd1);
      if (r === "ceiling") break;
      // requeue moved it to queued; put it back into rejected for the next iteration.
      if (i < MAX_REQUEUES) {
        db.query("UPDATE command_outbox SET delivery_state = 'rejected' WHERE command_id = ?").run(
          cmd1,
        );
      }
    }
    // Ensure it is rejected and past ceiling.
    db.query(
      "UPDATE command_outbox SET delivery_state = 'rejected', requeue_count = ? WHERE command_id = ?",
    ).run(MAX_REQUEUES + 1, cmd1);

    const published: Array<{ sessionId: string; type: string; payload: unknown }> = [];
    const result = handleRejectedStart({
      db,
      outbox,
      scheduler,
      capacityOf,
      runId: "run-1",
      commandId: cmd1,
      reason: "draining",
      publish: (event) => {
        published.push({
          sessionId: event.sessionId,
          type: event.type,
          payload: event.payload,
        });
      },
    });

    expect(result).toBe("abandoned");
    expect(outbox.get(cmd1)?.deliveryState).toBe("rejected");
    expect(outbox.get(cmd1)?.rejectionReason).toBe("queue_abandoned");

    const events = db.query("SELECT type, payload, attempt_id FROM run_events").all() as Array<{
      type: string;
      payload: string;
      attempt_id: string;
    }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("run.failed");
    expect(JSON.parse(events[0]!.payload)).toEqual({
      reason: "queue_abandoned",
      detail: "draining",
    });
    expect(events[0]!.attempt_id).toBe("attempt-1");

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      sessionId: "session-1",
      type: "run.failed",
      payload: { reason: "queue_abandoned", detail: "draining" },
    });

    // Slot freed.
    expect(scheduler.activeRunFor("session-1")).toBeUndefined();
  });
});
