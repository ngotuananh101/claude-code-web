/**
 * Scheduled tasks (§11.5): the control server's durable mirror of the CLI's
 * session-only `CronCreate` timers.
 *
 * The runner emits `schedule.created` / `schedule.cancelled` from the raw SDK
 * frames; this module projects them into `scheduled_tasks`, and the tick loop
 * reads due rows by `(state, next_fire_at)` and dispatches ordinary runs. The
 * cron expression is interpreted in the zone the runner reported, so "58 17"
 * means what the user saw on the runner's clock.
 *
 * A projection is at-least-once (§12.2): the same event may arrive twice, and
 * `schedule_id` is derived from `(attemptId, toolCallId)` so `INSERT OR IGNORE`
 * is idempotent even when the CLI's own task id is absent.
 */

import type { Database } from "bun:sqlite";
import {
  parseScheduleCancelledPayload,
  parseScheduleCreatedPayload,
  type ScheduledTask,
  type ScheduleState,
} from "@cc-web/protocol";
import { CronExpressionParser } from "cron-parser";
import { sessionPin } from "./sessions.ts";

export type ScheduleRecord = {
  scheduleId: string;
  sessionId: string;
  ownerId: string;
  workspaceId: string;
  runnerId: string;
  originAttemptId: string;
  cliTaskId?: string;
  cron: string;
  timezone: string;
  recurring: boolean;
  prompt: string;
  nextFireAt: number;
  state: ScheduleState;
  createdAt: number;
  lastFiredAt?: number;
};

/** A journal event as the projection sees it (the `onEvents` callback shape). */
export type ScheduleEventInput = {
  type: string;
  sessionId: string;
  attemptId: string;
  payload: unknown;
};

/**
 * The next epoch-ms fire time for `cron` in `timezone` after `afterMs`, or
 * undefined when the cron or the zone does not parse. Callers treat undefined
 * as "this schedule cannot be scheduled" — never as an error to throw.
 */
export function computeNextFire(
  cron: string,
  timezone: string,
  afterMs: number,
): number | undefined {
  try {
    const instant = CronExpressionParser.parse(cron, {
      tz: timezone,
      currentDate: new Date(afterMs),
    })
      .next()
      .getTime();
    return Number.isFinite(instant) ? instant : undefined;
  } catch {
    return undefined;
  }
}

export function projectScheduleEvent(db: Database, event: ScheduleEventInput): void {
  // The journal redelivers events, and projection runs inside the ingest
  // path: a throw here would drop the rest of the frame. Bad data becomes a
  // warning and a skipped row, never a wedged server.
  try {
    if (event.type === "schedule.created") {
      projectCreated(db, event);
    } else if (event.type === "schedule.cancelled") {
      projectCancelled(db, event);
    }
  } catch (error) {
    console.warn(`scheduled-tasks: projection failed for ${event.type}`, error);
  }
}

function projectCreated(db: Database, event: ScheduleEventInput): void {
  const payload = parseScheduleCreatedPayload(event.payload);
  if (payload === undefined) {
    console.warn(`scheduled-tasks: ignoring malformed schedule.created (${event.attemptId})`);
    return;
  }

  // The pin is the only source of (owner, workspace, runner) for the row: a
  // session that was never dispatched has no runner to fire on.
  const pin = sessionPin(db, event.sessionId);
  if (pin === undefined) {
    console.warn(
      `scheduled-tasks: no session pin for ${event.sessionId}; dropping schedule ${payload.toolCallId}`,
    );
    return;
  }

  const nextFireAt =
    payload.nextFireAt ?? computeNextFire(payload.cron, payload.timezone, Date.now());
  if (nextFireAt === undefined) {
    console.warn(
      `scheduled-tasks: unparseable cron "${payload.cron}" in ${payload.timezone}; dropping schedule ${payload.toolCallId}`,
    );
    return;
  }

  db.query(
    `INSERT OR IGNORE INTO scheduled_tasks (
       schedule_id, session_id, owner_id, workspace_id, runner_id,
       origin_attempt_id, cli_task_id, cron, timezone, recurring,
       prompt, next_fire_at, state, created_at, last_fired_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
  ).run(
    `sched_${event.attemptId}_${payload.toolCallId}`,
    event.sessionId,
    pin.ownerId,
    pin.workspaceId,
    pin.runnerId,
    event.attemptId,
    payload.cliTaskId ?? null,
    payload.cron,
    payload.timezone,
    payload.recurring ? 1 : 0,
    payload.prompt,
    nextFireAt,
    Date.now(),
  );
}

function projectCancelled(db: Database, event: ScheduleEventInput): void {
  const payload = parseScheduleCancelledPayload(event.payload);
  if (payload === undefined) {
    console.warn(`scheduled-tasks: ignoring malformed schedule.cancelled (${event.attemptId})`);
    return;
  }

  // Scoped to the creating attempt: two attempts may hold CLI tasks with the
  // same id, and only the one that created the row may close it.
  db.query(
    `UPDATE scheduled_tasks SET state = 'cancelled'
     WHERE origin_attempt_id = ? AND cli_task_id = ? AND state = 'active'`,
  ).run(event.attemptId, payload.cliTaskId);
}

export function dueSchedules(db: Database, now: number, limit = 20): ScheduleRecord[] {
  const rows = db
    .query(
      `SELECT * FROM scheduled_tasks
       WHERE state = 'active' AND next_fire_at <= ?
       ORDER BY next_fire_at, created_at
       LIMIT ?`,
    )
    .all(now, limit) as Array<Record<string, unknown>>;
  return rows.map(toRecord);
}

export function advanceSchedule(
  db: Database,
  scheduleId: string,
  input: { state: ScheduleState; nextFireAt?: number; lastFiredAt?: number },
): void {
  db.query(
    `UPDATE scheduled_tasks
     SET state = ?, next_fire_at = COALESCE(?, next_fire_at),
         last_fired_at = COALESCE(?, last_fired_at)
     WHERE schedule_id = ?`,
  ).run(input.state, input.nextFireAt ?? null, input.lastFiredAt ?? null, scheduleId);
}

/**
 * Owner-scoped cancel: false when the row does not exist, is not the
 * caller's, or is no longer active.
 */
export function cancelScheduleForOwner(db: Database, scheduleId: string, ownerId: string): boolean {
  const result = db
    .query(
      `UPDATE scheduled_tasks SET state = 'cancelled'
       WHERE schedule_id = ? AND owner_id = ? AND state = 'active'`,
    )
    .run(scheduleId, ownerId);
  return result.changes > 0;
}

export function listActiveSchedules(db: Database, sessionId: string): ScheduledTask[] {
  const rows = db
    .query(
      `SELECT schedule_id, session_id, cron, timezone, recurring,
              prompt, next_fire_at, state, created_at, last_fired_at
       FROM scheduled_tasks
       WHERE session_id = ? AND state = 'active'
       ORDER BY next_fire_at, created_at`,
    )
    .all(sessionId) as Array<Record<string, unknown>>;
  return rows.map(toTask);
}

/**
 * Whether a run id already exists anywhere a dispatch would land: the live
 * slot, the outbox (queued), or the journal (started/finished). The tick
 * consults it with the deterministic run id so a server restart between
 * "dispatch" and "advance" cannot fire the same slot twice.
 */
export function runKnown(db: Database, runId: string): boolean {
  const row = db
    .query(
      `SELECT EXISTS (
         SELECT 1 FROM active_runs WHERE run_id = ?
         UNION ALL
         SELECT 1 FROM command_outbox WHERE run_id = ?
         UNION ALL
         SELECT 1 FROM run_events WHERE run_id = ?
       ) AS known`,
    )
    .get(runId, runId, runId) as { known: number };
  return row.known === 1;
}

function toTask(row: Record<string, unknown>): ScheduledTask {
  const lastFiredAt = row["last_fired_at"];
  return {
    scheduleId: String(row["schedule_id"]),
    sessionId: String(row["session_id"]),
    cron: String(row["cron"]),
    timezone: String(row["timezone"]),
    recurring: Number(row["recurring"]) === 1,
    prompt: String(row["prompt"]),
    nextFireAt: Number(row["next_fire_at"]),
    state: row["state"] as ScheduleState,
    createdAt: Number(row["created_at"]),
    ...(lastFiredAt === null || lastFiredAt === undefined
      ? {}
      : { lastFiredAt: Number(lastFiredAt) }),
  };
}

function toRecord(row: Record<string, unknown>): ScheduleRecord {
  const cliTaskId = row["cli_task_id"];
  const lastFiredAt = row["last_fired_at"];
  return {
    scheduleId: String(row["schedule_id"]),
    sessionId: String(row["session_id"]),
    ownerId: String(row["owner_id"]),
    workspaceId: String(row["workspace_id"]),
    runnerId: String(row["runner_id"]),
    originAttemptId: String(row["origin_attempt_id"]),
    ...(cliTaskId === null || cliTaskId === undefined ? {} : { cliTaskId: String(cliTaskId) }),
    cron: String(row["cron"]),
    timezone: String(row["timezone"]),
    recurring: Number(row["recurring"]) === 1,
    prompt: String(row["prompt"]),
    nextFireAt: Number(row["next_fire_at"]),
    state: row["state"] as ScheduleState,
    createdAt: Number(row["created_at"]),
    ...(lastFiredAt === null || lastFiredAt === undefined
      ? {}
      : { lastFiredAt: Number(lastFiredAt) }),
  };
}
