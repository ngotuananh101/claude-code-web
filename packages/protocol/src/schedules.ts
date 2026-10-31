/**
 * Scheduled-task event payloads (§11.5).
 *
 * The runner mirrors `CronCreate`/`CronDelete` tool results as
 * `schedule.created` / `schedule.cancelled`; the control server projects them
 * into `scheduled_tasks` and owns the clock from then on. Validation lives on
 * this wire contract because the server has no schema layer for event payloads:
 * a payload that gets past this parser is one the projection may write, and a
 * bad row would wedge the scheduling tick.
 */

/** Where a schedule row stands. `orphaned` means its session pin vanished. */
export type ScheduleState = "active" | "done" | "cancelled" | "orphaned";

/**
 * The wire cap for a schedule's prompt. A producer must clamp to this: the
 * parser refuses an over-limit payload, and the projection then drops the
 * whole schedule without telling anyone.
 */
export const SCHEDULE_PROMPT_MAX = 4000;

/**
 * `schedule.created`: a schedule the agent asked the CLI to create.
 *
 * `cron` is the expression from the tool input: the server recomputes every
 * fire from it, and the structured `humanSchedule` is display text ("Every
 * minute") that cron-parser cannot read — it is only a fallback for a CLI
 * that answered in plain text. `cliTaskId` and `nextFireAt` come from the
 * structured tool result and may be absent in the same fallback case.
 */
export type ScheduleCreatedPayload = {
  toolCallId: string;
  cliTaskId?: string;
  cron: string;
  recurring: boolean;
  prompt: string;
  /** Epoch ms on the runner's clock. Absent means the server computes it. */
  nextFireAt?: number;
  /** IANA zone of the runner; the server interprets the cron in it. */
  timezone: string;
};

/** `schedule.cancelled`: a `CronDelete` that succeeded. */
export type ScheduleCancelledPayload = {
  toolCallId: string;
  cliTaskId: string;
};

/** The browser-facing shape of one active schedule (`GET …/schedules`). */
export type ScheduledTask = {
  scheduleId: string;
  sessionId: string;
  cron: string;
  timezone: string;
  recurring: boolean;
  prompt: string;
  nextFireAt: number;
  state: ScheduleState;
  createdAt: number;
  lastFiredAt?: number;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A non-empty string of at most `max` characters, else undefined. */
function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value !== "" && value.length <= max ? value : undefined;
}

export function parseScheduleCreatedPayload(value: unknown): ScheduleCreatedPayload | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;

  const toolCallId = boundedString(record["toolCallId"], 200);
  const cron = boundedString(record["cron"], 200);
  const prompt = boundedString(record["prompt"], SCHEDULE_PROMPT_MAX);
  const timezone = boundedString(record["timezone"], 100);
  const recurring = record["recurring"];
  if (
    toolCallId === undefined ||
    cron === undefined ||
    prompt === undefined ||
    timezone === undefined ||
    typeof recurring !== "boolean"
  ) {
    return undefined;
  }

  // Optional fields are all-or-nothing: present must be valid, absent stays
  // absent — the projection distinguishes "the CLI said" from "the server must
  // compute it".
  const rawCliTaskId = record["cliTaskId"];
  const cliTaskId = rawCliTaskId === undefined ? undefined : boundedString(rawCliTaskId, 200);
  if (rawCliTaskId !== undefined && cliTaskId === undefined) return undefined;

  const rawNextFireAt = record["nextFireAt"];
  const nextFireAt =
    rawNextFireAt !== undefined &&
    typeof rawNextFireAt === "number" &&
    Number.isFinite(rawNextFireAt) &&
    rawNextFireAt > 0
      ? rawNextFireAt
      : undefined;
  if (rawNextFireAt !== undefined && nextFireAt === undefined) return undefined;

  return {
    toolCallId,
    ...(cliTaskId === undefined ? {} : { cliTaskId }),
    cron,
    recurring,
    prompt,
    ...(nextFireAt === undefined ? {} : { nextFireAt }),
    timezone,
  };
}

export function parseScheduleCancelledPayload(
  value: unknown,
): ScheduleCancelledPayload | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;

  const toolCallId = boundedString(record["toolCallId"], 200);
  const cliTaskId = boundedString(record["cliTaskId"], 200);
  if (toolCallId === undefined || cliTaskId === undefined) return undefined;

  return { toolCallId, cliTaskId };
}
