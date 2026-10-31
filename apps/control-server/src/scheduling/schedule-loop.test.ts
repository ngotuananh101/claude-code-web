import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  ensureSessionPin,
  migrate,
  projectScheduleEvent,
  type RunnerCapacity,
  Scheduler,
} from "@cc-web/control-db";
import { runScheduleTick } from "./schedule-loop.ts";

/**
 * The scheduling tick (§11.5, §5.4).
 *
 * The order of checks in the tick is the double-fire guard: an origin attempt
 * that is still running owns its own CLI timer, a run id that already exists
 * anywhere means this slot fired before, and only then does the server
 * dispatch. Everything below pins one of those branches.
 */

const NEXT_FIRE = 1793444280000;

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  ensureSessionPin(db, {
    sessionId: "session-1",
    ownerId: "user-1",
    workspaceId: "workspace-1",
    runnerId: "runner-a",
  });
  return { db, scheduler: new Scheduler(db) };
}

function capacity(): RunnerCapacity {
  return { runnerId: "runner-a", state: "ready", maxConcurrentRuns: 1, activeRuns: 0 };
}

type ProjectOverrides = {
  attemptId?: string;
  toolCallId?: string;
  payload?: Partial<{
    cron: string;
    recurring: boolean;
    nextFireAt: number;
  }>;
};

function project(db: Database, overrides: ProjectOverrides = {}): void {
  projectScheduleEvent(
    db,
    {
      type: "schedule.created",
      sessionId: "session-1",
      attemptId: overrides.attemptId ?? "attempt-1",
      payload: {
        toolCallId: overrides.toolCallId ?? "toolu_1",
        cliTaskId: "af5c4b05",
        cron: "58 17 31 10 *",
        recurring: false,
        prompt: "Kiểm tra dung lượng ổ đĩa",
        nextFireAt: NEXT_FIRE,
        timezone: "Asia/Ho_Chi_Minh",
        ...overrides.payload,
      },
    },
    "runner-a",
  );
}

function commands(db: Database) {
  return db
    .query("SELECT command_id, run_id, payload FROM command_outbox ORDER BY created_at, command_id")
    .all() as Array<{ command_id: string; run_id: string; payload: string }>;
}

function row(db: Database, scheduleId = "sched_attempt-1_toolu_1"): Record<string, unknown> {
  return db.query("SELECT * FROM scheduled_tasks WHERE schedule_id = ?").get(scheduleId) as Record<
    string,
    unknown
  >;
}

function insertCommand(db: Database, runId: string, commandId: string): void {
  db.query(
    "INSERT INTO command_outbox (command_id, runner_id, kind, payload, fingerprint, issued_at, run_id, delivery_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    commandId,
    "runner-a",
    "run.start",
    "{}",
    "fp",
    "2026-10-31T00:00:00Z",
    runId,
    "pending",
    Date.now(),
  );
}

describe("runScheduleTick", () => {
  test("a due one-shot is dispatched, marked done and leaves a run.start in the outbox", async () => {
    const { db, scheduler } = setup();
    project(db);

    await runScheduleTick({
      db,
      scheduler,
      runnerGateway: { stateOf: () => "ready" },
      now: () => NEXT_FIRE,
      log: () => {},
    });

    const sent = commands(db);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.run_id).toBe("run_sched_sched_attempt-1_toolu_1_1793444280000");
    expect(JSON.parse(sent[0]!.payload)).toMatchObject({
      scheduleId: "sched_attempt-1_toolu_1",
      scheduleCron: "58 17 31 10 *",
    });
    expect(row(db)).toMatchObject({ state: "done", last_fired_at: NEXT_FIRE });
  });

  test("a one-shot already due fires on the next tick", async () => {
    const { db, scheduler } = setup();
    project(db);

    await runScheduleTick({
      db,
      scheduler,
      runnerGateway: { stateOf: () => "ready" },
      now: () => NEXT_FIRE + 90_000,
      log: () => {},
    });

    expect(commands(db)).toHaveLength(1);
    expect(row(db)["state"]).toBe("done");
  });

  test("the origin attempt still running owns the fire", async () => {
    const { db, scheduler } = setup();
    project(db);
    // The attempt that created the schedule is still live: its own in-process
    // timer may fire, so the server must not dispatch a second copy.
    const decision = await scheduler.dispatch(
      {
        sessionId: "session-1",
        runId: "run-manual",
        attemptId: "attempt-1",
        workspaceId: "workspace-1",
        prompt: "hello",
        ownerId: "user-1",
      },
      capacity(),
    );
    expect(decision.ok).toBe(true);

    await runScheduleTick({
      db,
      scheduler,
      runnerGateway: { stateOf: () => "ready" },
      now: () => NEXT_FIRE,
      log: () => {},
    });

    expect(commands(db)).toHaveLength(1);
    expect(row(db)["state"]).toBe("done");
  });

  test("an offline runner leaves the row due for a later tick", async () => {
    const { db, scheduler } = setup();
    project(db);

    await runScheduleTick({
      db,
      scheduler,
      runnerGateway: { stateOf: () => "offline" },
      now: () => NEXT_FIRE,
      log: () => {},
    });
    expect(commands(db)).toHaveLength(0);
    expect(row(db)).toMatchObject({ state: "active", next_fire_at: NEXT_FIRE });

    await runScheduleTick({
      db,
      scheduler,
      runnerGateway: { stateOf: () => "ready" },
      now: () => NEXT_FIRE,
      log: () => {},
    });
    expect(commands(db)).toHaveLength(1);
    expect(row(db)["state"]).toBe("done");
  });

  test("a busy session retries the schedule on a later tick", async () => {
    const { db, scheduler } = setup();
    project(db);
    await scheduler.dispatch(
      {
        sessionId: "session-1",
        runId: "run-other",
        attemptId: "attempt-other",
        workspaceId: "workspace-1",
        prompt: "hello",
        ownerId: "user-1",
      },
      capacity(),
    );

    await runScheduleTick({
      db,
      scheduler,
      runnerGateway: { stateOf: () => "ready" },
      now: () => NEXT_FIRE,
      log: () => {},
    });
    expect(commands(db)).toHaveLength(1);
    expect(row(db)["state"]).toBe("active");

    scheduler.release("run-other");
    await runScheduleTick({
      db,
      scheduler,
      runnerGateway: { stateOf: () => "ready" },
      now: () => NEXT_FIRE,
      log: () => {},
    });
    expect(commands(db)).toHaveLength(2);
    expect(row(db)["state"]).toBe("done");
  });

  test("two due schedules for one session dispatch one and retry the other", async () => {
    const { db, scheduler } = setup();
    project(db, { attemptId: "attempt-1", toolCallId: "toolu_1" });
    project(db, { attemptId: "attempt-2", toolCallId: "toolu_2" });

    await runScheduleTick({
      db,
      scheduler,
      runnerGateway: { stateOf: () => "ready" },
      now: () => NEXT_FIRE,
      log: () => {},
    });
    const first = commands(db);
    expect(first).toHaveLength(1);

    const dispatchedId = JSON.parse(first[0]!.payload).scheduleId as string;
    const otherId =
      dispatchedId === "sched_attempt-1_toolu_1"
        ? "sched_attempt-2_toolu_2"
        : "sched_attempt-1_toolu_1";
    expect(row(db, otherId)).toMatchObject({ state: "active", next_fire_at: NEXT_FIRE });

    scheduler.release(first[0]!.run_id);
    await runScheduleTick({
      db,
      scheduler,
      runnerGateway: { stateOf: () => "ready" },
      now: () => NEXT_FIRE,
      log: () => {},
    });
    expect(commands(db)).toHaveLength(2);
    expect(row(db, otherId)["state"]).toBe("done");
  });

  test("a known run id is advanced instead of dispatched twice", async () => {
    const { db, scheduler } = setup();
    project(db);
    insertCommand(db, "run_sched_sched_attempt-1_toolu_1_1793444280000", "cmd-known");

    await runScheduleTick({
      db,
      scheduler,
      runnerGateway: { stateOf: () => "ready" },
      now: () => NEXT_FIRE,
      log: () => {},
    });

    expect(commands(db)).toHaveLength(1);
    expect(commands(db)[0]!.command_id).toBe("cmd-known");
    expect(row(db)["state"]).toBe("done");
  });

  test("a recurring row advances to its next fire instead of finishing", async () => {
    const { db, scheduler } = setup();
    project(db, { payload: { cron: "*/5 * * * *", recurring: true } });

    await runScheduleTick({
      db,
      scheduler,
      runnerGateway: { stateOf: () => "ready" },
      now: () => NEXT_FIRE,
      log: () => {},
    });

    expect(commands(db)).toHaveLength(1);
    const fired = row(db);
    expect(fired["state"]).toBe("active");
    expect(Number(fired["next_fire_at"])).toBeGreaterThan(NEXT_FIRE);
    expect(Number(fired["last_fired_at"])).toBe(NEXT_FIRE);
  });

  test("a repeating row whose cron stopped parsing is cancelled", async () => {
    const { db, scheduler } = setup();
    // The projection refuses an invalid cron, so the row can only exist if it
    // was written directly — the tick must still not throw on it.
    db.query(
      `INSERT INTO scheduled_tasks (
         schedule_id, session_id, owner_id, workspace_id, runner_id,
         origin_attempt_id, cli_task_id, cron, timezone, recurring,
         prompt, next_fire_at, state, created_at, last_fired_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
    ).run(
      "sched_bad",
      "session-1",
      "user-1",
      "workspace-1",
      "runner-a",
      "attempt-bad",
      null,
      "99 99 99 99 *",
      "UTC",
      1,
      "prompt",
      NEXT_FIRE,
      Date.now(),
    );

    await runScheduleTick({
      db,
      scheduler,
      runnerGateway: { stateOf: () => "ready" },
      now: () => NEXT_FIRE,
      log: () => {},
    });

    expect(row(db, "sched_bad")["state"]).toBe("cancelled");
  });

  test("a schedule whose session pin vanished is orphaned", async () => {
    const { db, scheduler } = setup();
    project(db);
    db.query("DELETE FROM sessions WHERE id = 'session-1'").run();

    await runScheduleTick({
      db,
      scheduler,
      runnerGateway: { stateOf: () => "ready" },
      now: () => NEXT_FIRE,
      log: () => {},
    });

    expect(row(db)["state"]).toBe("orphaned");
    expect(commands(db)).toHaveLength(0);
  });

  test("a page of refused rows cannot starve a healthy schedule behind them", async () => {
    const { db, scheduler } = setup();
    // Twenty rows pinned to a dead runner, all older than the healthy one.
    // A fixed LIMIT 20 returns exactly these on every tick, and the healthy
    // row on the next page is never looked at: one broken runner starves
    // every schedule behind it, server-wide.
    for (let index = 0; index < 20; index += 1) {
      ensureSessionPin(db, {
        sessionId: `stuck-${index}`,
        ownerId: "user-1",
        workspaceId: "workspace-1",
        runnerId: "runner-stuck",
      });
      projectScheduleEvent(
        db,
        {
          type: "schedule.created",
          sessionId: `stuck-${index}`,
          attemptId: `attempt-stuck-${index}`,
          payload: {
            toolCallId: `toolu_stuck_${index}`,
            cron: "0 0 1 1 *",
            recurring: false,
            prompt: "stuck",
            nextFireAt: NEXT_FIRE - 1000,
            timezone: "UTC",
          },
        },
        "runner-stuck",
      );
    }
    project(db, { attemptId: "attempt-healthy", toolCallId: "toolu-healthy" });

    await runScheduleTick({
      db,
      scheduler,
      runnerGateway: { stateOf: (runnerId) => (runnerId === "runner-a" ? "ready" : "offline") },
      now: () => NEXT_FIRE,
      log: () => {},
    });

    const sent = commands(db);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toContain("sched_attempt-healthy_toolu-healthy");
    expect(row(db, "sched_attempt-healthy_toolu-healthy")["state"]).toBe("done");
  });
});
