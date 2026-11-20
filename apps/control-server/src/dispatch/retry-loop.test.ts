import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CommandOutbox, migrate, type RunnerState, Scheduler } from "@cc-web/control-db";
import { runRetryTick, startRetryLoop } from "./retry-loop.ts";

async function setup() {
  const db = new Database(":memory:");
  migrate(db);
  let now = 1_000;
  let state: RunnerState = "ready";
  let maxConcurrentRuns = 1;
  const outbox = new CommandOutbox(db);
  const scheduler = new Scheduler(db, { now: () => now });
  const capacity = (runnerId: string) =>
    scheduler.capacityFor(runnerId, { runnerId, state, maxConcurrentRuns, activeRuns: 0 });
  const decision = await scheduler.dispatch(
    {
      sessionId: "session-1",
      ownerId: "user-1",
      workspaceId: "workspace-1",
      runId: "run-1",
      attemptId: "attempt-1",
      prompt: "Wait for workspace cleanup",
    },
    capacity("runner-a"),
  );
  if (!decision.ok || decision.queued) throw new Error("expected an admitted run");
  outbox.markRejected(decision.commandId, "workspace_busy");
  scheduler.release("run-1");
  outbox.requeue(decision.commandId, { now });
  return {
    db,
    outbox,
    scheduler,
    commandId: decision.commandId,
    options: {
      outbox,
      promoteRunner: (runnerId: string) => scheduler.promote(runnerId, capacity(runnerId)),
    },
    setNow: (value: number) => {
      now = value;
    },
    setState: (value: RunnerState) => {
      state = value;
    },
    setCapacity: (value: number) => {
      maxConcurrentRuns = value;
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("retry loop did not promote due work");
    await Bun.sleep(5);
  }
}

describe("durable retry wakeups", () => {
  test("a tick only admits a retry after its deadline", async () => {
    const { db, outbox, scheduler, commandId, options, setNow } = await setup();
    try {
      runRetryTick(options);
      setNow(1_999);
      runRetryTick(options);
      expect(outbox.get(commandId)).toMatchObject({ deliveryState: "queued", requeueCount: 1 });
      expect(scheduler.activeRunFor("session-1")).toBeUndefined();

      setNow(2_000);
      runRetryTick(options);
      runRetryTick(options);
      expect(outbox.get(commandId)).toMatchObject({ deliveryState: "pending", requeueCount: 1 });
      expect(scheduler.activeRunFor("session-1")?.runId).toBe("run-1");
    } finally {
      db.close();
    }
  });

  test("due work survives offline and full-capacity ticks", async () => {
    const { db, outbox, commandId, options, setNow, setState, setCapacity } = await setup();
    try {
      setNow(2_000);
      setState("offline");
      runRetryTick(options);
      expect(outbox.get(commandId)?.deliveryState).toBe("queued");
      setState("ready");
      setCapacity(0);
      runRetryTick(options);
      expect(outbox.get(commandId)?.deliveryState).toBe("queued");
      setCapacity(1);
      runRetryTick(options);
      expect(outbox.get(commandId)?.deliveryState).toBe("pending");
    } finally {
      db.close();
    }
  });

  test("a fresh loop retries persisted work without an incoming event and stops cleanly", async () => {
    const { db, outbox, scheduler, commandId, options, setNow } = await setup();
    const stopped = startRetryLoop({ ...options, intervalMs: 5 });
    stopped.stop();
    setNow(2_000);
    await Bun.sleep(25);
    expect(outbox.get(commandId)?.deliveryState).toBe("queued");

    const restarted = startRetryLoop({ ...options, intervalMs: 5 });
    try {
      await waitFor(() => scheduler.activeRunFor("session-1") !== undefined);
      expect(outbox.get(commandId)?.deliveryState).toBe("pending");
    } finally {
      restarted.stop();
      db.close();
    }
    // A surviving interval would query the closed database here.
    await Bun.sleep(25);
  });

  test("one runner's promotion failure does not prevent another due runner from starting", async () => {
    const { db, outbox, options, setNow } = await setup();
    await outbox.enqueue({
      commandId: "cmd-other",
      runnerId: "runner-b",
      sessionId: "session-b",
      runId: "run-b",
      attemptId: "attempt-b",
      workspaceId: "workspace-b",
      kind: "run.start",
      issuedAt: "2026-11-19T00:00:00.000Z",
      payload: { prompt: "Other runner" },
    });
    outbox.markRejected("cmd-other", "workspace_busy");
    outbox.requeue("cmd-other", { now: 1_000 });
    setNow(2_000);
    const warnings: string[] = [];
    try {
      runRetryTick({
        ...options,
        log: (message) => warnings.push(message),
        promoteRunner: (runnerId) => {
          if (runnerId === "runner-a") throw new Error("database busy");
          options.promoteRunner(runnerId);
        },
      });
      expect(outbox.get("cmd-other")?.deliveryState).toBe("pending");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("runner-a");
    } finally {
      db.close();
    }
  });

  test("cancelling a cooldown anchor does not strand its ordinary queued sibling", async () => {
    const { db, outbox, scheduler, commandId, options } = await setup();
    try {
      const sibling = await scheduler.dispatch(
        {
          sessionId: "session-2",
          ownerId: "user-1",
          workspaceId: "workspace-1",
          runId: "run-2",
          attemptId: "attempt-2",
          prompt: "Continue after the cancelled retry",
        },
        { runnerId: "runner-a", state: "ready", maxConcurrentRuns: 1, activeRuns: 0 },
      );
      expect(sibling).toMatchObject({ ok: true, queued: true });
      expect(await scheduler.cancel("run-1")).toEqual({ ok: true, queued: true });
      runRetryTick(options);
      expect(outbox.get(commandId)?.deliveryState).toBe("rejected");
      expect(scheduler.activeRunFor("session-2")?.runId).toBe("run-2");
    } finally {
      db.close();
    }
  });

  test("cancelling a waiting retry prevents a later wakeup from admitting it", async () => {
    const { db, outbox, scheduler, commandId, options, setNow } = await setup();
    try {
      expect(await scheduler.cancel("run-1")).toMatchObject({ ok: true });
      setNow(10_000);
      runRetryTick(options);
      expect(outbox.get(commandId)).toMatchObject({
        deliveryState: "rejected",
        rejectionReason: "cancelled",
      });
      expect(scheduler.activeRunFor("session-1")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
