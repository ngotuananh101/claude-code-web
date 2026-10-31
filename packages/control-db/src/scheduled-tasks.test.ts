import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "./db.ts";
import {
  advanceSchedule,
  cancelScheduleForOwner,
  computeNextFire,
  dueSchedules,
  listActiveSchedules,
  projectScheduleEvent,
  runKnown,
} from "./scheduled-tasks.ts";
import { ensureSessionPin } from "./sessions.ts";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  ensureSessionPin(db, {
    sessionId: "session-1",
    ownerId: "user-1",
    workspaceId: "workspace-1",
    runnerId: "runner-a",
  });
  return db;
}

const created = {
  type: "schedule.created",
  sessionId: "session-1",
  attemptId: "attempt-1",
  payload: {
    toolCallId: "toolu_1",
    cliTaskId: "af5c4b05",
    cron: "58 17 31 10 *",
    recurring: false,
    prompt: "Kiểm tra dung lượng ổ đĩa",
    nextFireAt: 1793444280000,
    timezone: "Asia/Ho_Chi_Minh",
  },
};

function rows(db: Database) {
  return db.query("SELECT * FROM scheduled_tasks ORDER BY created_at").all() as Array<
    Record<string, unknown>
  >;
}

describe("computeNextFire", () => {
  test("a five-field cron resolves in the schedule's timezone", () => {
    // 2026-10-31T10:00:00Z is 17:00 in Asia/Ho_Chi_Minh, so 17:58 is 10:58Z.
    expect(
      computeNextFire("58 17 31 10 *", "Asia/Ho_Chi_Minh", Date.UTC(2026, 9, 31, 10, 0, 0)),
    ).toBe(Date.UTC(2026, 9, 31, 10, 58, 0));
  });

  test("a recurring cron moves to the next slot", () => {
    expect(computeNextFire("*/5 * * * *", "UTC", Date.UTC(2026, 9, 31, 10, 1, 0))).toBe(
      Date.UTC(2026, 9, 31, 10, 5, 0),
    );
  });

  test("predefined expressions are accepted", () => {
    expect(computeNextFire("@daily", "UTC", Date.UTC(2026, 9, 31, 10, 1, 0))).toBe(
      Date.UTC(2026, 10, 1, 0, 0, 0),
    );
  });

  test("an unparseable cron answers undefined instead of throwing", () => {
    expect(computeNextFire("99 99 99 99 *", "UTC", Date.now())).toBeUndefined();
  });

  test("an unknown timezone answers undefined instead of throwing", () => {
    expect(computeNextFire("58 17 * * *", "Not/AZone", Date.now())).toBeUndefined();
  });
});

describe("projectScheduleEvent", () => {
  test("a valid schedule.created creates one row from the session pin", () => {
    const db = setup();
    projectScheduleEvent(db, created);

    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]).toMatchObject({
      schedule_id: "sched_attempt-1_toolu_1",
      session_id: "session-1",
      owner_id: "user-1",
      workspace_id: "workspace-1",
      runner_id: "runner-a",
      origin_attempt_id: "attempt-1",
      cli_task_id: "af5c4b05",
      cron: "58 17 31 10 *",
      timezone: "Asia/Ho_Chi_Minh",
      recurring: 0,
      prompt: "Kiểm tra dung lượng ổ đĩa",
      next_fire_at: 1793444280000,
      state: "active",
    });
  });

  test("projecting the same event twice creates one row", () => {
    const db = setup();
    projectScheduleEvent(db, created);
    projectScheduleEvent(db, created);
    expect(rows(db)).toHaveLength(1);
  });

  test("a session with no pin creates no row", () => {
    const db = setup();
    projectScheduleEvent(db, { ...created, sessionId: "session-unknown" });
    expect(rows(db)).toHaveLength(0);
  });

  test("an invalid payload creates no row and does not throw", () => {
    const db = setup();
    projectScheduleEvent(db, {
      ...created,
      payload: { cron: "x".repeat(201) },
    });
    expect(rows(db)).toHaveLength(0);
  });

  test("a missing nextFireAt is computed from the cron", () => {
    const db = setup();
    const { nextFireAt, ...payload } = created.payload;
    projectScheduleEvent(db, { ...created, payload: { ...payload, cron: "*/5 * * * *" } });
    const row = rows(db)[0]!;
    expect(Number(row["next_fire_at"])).toBeGreaterThan(Date.now());
  });

  test("an unparseable cron with no nextFireAt creates no row", () => {
    const db = setup();
    const { nextFireAt, ...payload } = created.payload;
    projectScheduleEvent(db, { ...created, payload: { ...payload, cron: "99 99 99 99 *" } });
    expect(rows(db)).toHaveLength(0);
  });

  test("schedule.cancelled closes the row created by the same attempt", () => {
    const db = setup();
    projectScheduleEvent(db, created);
    projectScheduleEvent(db, {
      type: "schedule.cancelled",
      sessionId: "session-1",
      attemptId: "attempt-1",
      payload: { toolCallId: "toolu_2", cliTaskId: "af5c4b05" },
    });
    expect(rows(db)[0]!["state"]).toBe("cancelled");
  });

  test("a cancellation for an unknown cli task is a no-op", () => {
    const db = setup();
    projectScheduleEvent(db, created);
    projectScheduleEvent(db, {
      type: "schedule.cancelled",
      sessionId: "session-1",
      attemptId: "attempt-1",
      payload: { toolCallId: "toolu_2", cliTaskId: "never-seen" },
    });
    expect(rows(db)[0]!["state"]).toBe("active");
  });

  test("other event types are ignored", () => {
    const db = setup();
    projectScheduleEvent(db, { ...created, type: "run.started" });
    expect(rows(db)).toHaveLength(0);
  });
});

describe("schedule queries", () => {
  test("dueSchedules returns active rows at or before the given time, oldest first", () => {
    const db = setup();
    projectScheduleEvent(db, created); // next_fire_at 1793444280000
    projectScheduleEvent(db, {
      ...created,
      attemptId: "attempt-2",
      payload: { ...created.payload, toolCallId: "toolu_2", nextFireAt: 1793444000000 },
    });
    expect(dueSchedules(db, 1793444279999).map((row) => row.scheduleId)).toEqual([
      "sched_attempt-2_toolu_2",
    ]);
    expect(dueSchedules(db, 1793444280000).map((row) => row.scheduleId)).toEqual([
      "sched_attempt-2_toolu_2",
      "sched_attempt-1_toolu_1",
    ]);
  });

  test("advanceSchedule sets state, next fire and last fired", () => {
    const db = setup();
    projectScheduleEvent(db, created);
    advanceSchedule(db, "sched_attempt-1_toolu_1", {
      state: "active",
      nextFireAt: 1793444340000,
      lastFiredAt: 1793444280000,
    });
    expect(rows(db)[0]).toMatchObject({
      state: "active",
      next_fire_at: 1793444340000,
      last_fired_at: 1793444280000,
    });
    advanceSchedule(db, "sched_attempt-1_toolu_1", { state: "done", lastFiredAt: 1793444340000 });
    expect(rows(db)[0]).toMatchObject({ state: "done", last_fired_at: 1793444340000 });
  });

  test("cancelScheduleForOwner is owner-scoped and only cancels active rows", () => {
    const db = setup();
    projectScheduleEvent(db, created);
    expect(cancelScheduleForOwner(db, "sched_attempt-1_toolu_1", "someone-else")).toBe(false);
    expect(cancelScheduleForOwner(db, "sched_attempt-1_toolu_1", "user-1")).toBe(true);
    expect(rows(db)[0]!["state"]).toBe("cancelled");
    expect(cancelScheduleForOwner(db, "sched_attempt-1_toolu_1", "user-1")).toBe(false);
  });

  test("listActiveSchedules answers camelCase tasks for one session only", () => {
    const db = setup();
    projectScheduleEvent(db, created);
    ensureSessionPin(db, {
      sessionId: "session-2",
      ownerId: "user-1",
      workspaceId: "workspace-1",
      runnerId: "runner-a",
    });
    projectScheduleEvent(db, {
      ...created,
      sessionId: "session-2",
      attemptId: "attempt-9",
      payload: { ...created.payload, toolCallId: "toolu_9" },
    });
    cancelScheduleForOwner(db, "sched_attempt-9_toolu_9", "user-1");

    expect(listActiveSchedules(db, "session-1")).toEqual([
      {
        scheduleId: "sched_attempt-1_toolu_1",
        sessionId: "session-1",
        cron: "58 17 31 10 *",
        timezone: "Asia/Ho_Chi_Minh",
        recurring: false,
        prompt: "Kiểm tra dung lượng ổ đĩa",
        nextFireAt: 1793444280000,
        state: "active",
        createdAt: expect.any(Number),
      },
    ]);
    expect(listActiveSchedules(db, "session-2")).toEqual([]);
  });

  test("runKnown sees the outbox, the journal and active_runs", () => {
    const db = setup();
    expect(runKnown(db, "run_unknown")).toBe(false);

    db.query(
      "INSERT INTO active_runs (run_id, session_id, runner_id, attempt_id, dispatched_at) VALUES (?, ?, ?, ?, ?)",
    ).run("run_active", "session-1", "runner-a", "attempt-1", Date.now());
    expect(runKnown(db, "run_active")).toBe(true);

    db.query(
      "INSERT INTO command_outbox (command_id, runner_id, kind, payload, fingerprint, issued_at, run_id, delivery_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "cmd-1",
      "runner-a",
      "run.start",
      "{}",
      "fp",
      "2026-10-31T00:00:00Z",
      "run_queued",
      "pending",
      Date.now(),
    );
    expect(runKnown(db, "run_queued")).toBe(true);

    db.query(
      "INSERT INTO run_events (event_id, runner_id, boot_id, session_id, run_id, attempt_id, local_sequence, session_sequence, type, payload, occurred_at, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "evt-1",
      "runner-a",
      "boot-1",
      "session-1",
      "run_journaled",
      "attempt-1",
      1,
      1,
      "run.started",
      "{}",
      "2026-10-31T00:00:00Z",
      Date.now(),
    );
    expect(runKnown(db, "run_journaled")).toBe(true);
  });
});
