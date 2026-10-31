/**
 * The schedule mirror (§5.2 of the scheduled-tasks design).
 *
 * The CLI's `CronCreate` is an in-memory timer inside the CLI subprocess, and
 * cc-web's turn-based runs end that subprocess at `result` — so the schedule
 * itself has to survive elsewhere. This observer is the only runner-side piece:
 * it pairs each `CronCreate`/`CronDelete` tool_use block with its tool_result
 * frame and turns a successful result into a `schedule.*` event. The server
 * projects those events and owns the clock from then on.
 *
 * It reads raw SDK frames because `tool-results.ts` drops the frame-level
 * `tool_use_result` — which is exactly where the CLI's task id and first fire
 * time live. `tool_use_result` belongs to the frame as a whole, so a frame with
 * several tool_result blocks cannot attribute it; those fall back to the tool
 * input, which is also what a CLI that answered in plain text leaves us.
 */

import type { ScheduleCancelledPayload, ScheduleCreatedPayload } from "@cc-web/protocol";

export type ScheduleEvent =
  | { type: "schedule.created"; payload: ScheduleCreatedPayload }
  | { type: "schedule.cancelled"; payload: ScheduleCancelledPayload };

export type ScheduleObserver = (message: Record<string, unknown>) => ScheduleEvent[];

type PendingToolUse = { name: "CronCreate" | "CronDelete"; input: Record<string, unknown> };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function contentOf(message: Record<string, unknown>): unknown[] | undefined {
  const content = asRecord(message["message"])?.["content"];
  return Array.isArray(content) ? content : undefined;
}

function cronCreated(
  toolCallId: string,
  input: Record<string, unknown>,
  structured: Record<string, unknown> | undefined,
  timezone: string,
): ScheduleEvent | undefined {
  // The structured result is the CLI's own answer; the tool input is the model's
  // request. Prefer the answer, fall back to the request.
  const cron = nonEmpty(structured?.["humanSchedule"]) ?? nonEmpty(input["cron"]);
  const prompt = nonEmpty(input["prompt"]);
  if (cron === undefined || prompt === undefined) return undefined;

  const recurringCandidate = structured?.["recurring"] ?? input["recurring"];
  const recurring = typeof recurringCandidate === "boolean" ? recurringCandidate : false;

  const cliTaskId = nonEmpty(structured?.["id"]);
  const rawNextFireAt = structured?.["nextFireAt"];
  const nextFireAt =
    typeof rawNextFireAt === "number" && Number.isFinite(rawNextFireAt) && rawNextFireAt > 0
      ? rawNextFireAt
      : undefined;

  return {
    type: "schedule.created",
    payload: {
      toolCallId,
      ...(cliTaskId === undefined ? {} : { cliTaskId }),
      cron,
      recurring,
      prompt,
      ...(nextFireAt === undefined ? {} : { nextFireAt }),
      timezone,
    },
  };
}

function cronCancelled(
  toolCallId: string,
  input: Record<string, unknown>,
): ScheduleEvent | undefined {
  const cliTaskId = nonEmpty(input["id"]);
  if (cliTaskId === undefined) return undefined;
  return { type: "schedule.cancelled", payload: { toolCallId, cliTaskId } };
}

/**
 * One observer per attempt: the pending map is the correlation state between
 * tool_use and tool_result frames, and it must not leak across runs.
 */
export function createScheduleObserver(options: { timezone?: string } = {}): ScheduleObserver {
  const configured = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timezone = typeof configured === "string" && configured !== "" ? configured : "UTC";
  const pending = new Map<string, PendingToolUse>();

  return (message) => {
    const events: ScheduleEvent[] = [];
    const frameType = message["type"];

    if (frameType === "assistant") {
      for (const block of contentOf(message) ?? []) {
        const use = asRecord(block);
        if (use === undefined || use["type"] !== "tool_use") continue;
        const id = nonEmpty(use["id"]);
        const name = use["name"];
        if (id === undefined || (name !== "CronCreate" && name !== "CronDelete")) continue;
        pending.set(id, { name, input: asRecord(use["input"]) ?? {} });
      }
      return events;
    }

    if (frameType !== "user") return events;
    const content = contentOf(message);
    if (content === undefined) return events;

    const blocks = content
      .map(asRecord)
      .filter(
        (block): block is Record<string, unknown> =>
          block !== undefined &&
          block["type"] === "tool_result" &&
          nonEmpty(block["tool_use_id"]) !== undefined,
      );
    // `tool_use_result` describes the whole frame, so it is only trustworthy
    // when the frame carries exactly one result.
    const structured = blocks.length === 1 ? asRecord(message["tool_use_result"]) : undefined;

    for (const block of blocks) {
      const toolCallId = nonEmpty(block["tool_use_id"]);
      if (toolCallId === undefined) continue;
      const use = pending.get(toolCallId);
      pending.delete(toolCallId);
      if (use === undefined || block["is_error"] === true) continue;

      const event =
        use.name === "CronCreate"
          ? cronCreated(toolCallId, use.input, structured, timezone)
          : cronCancelled(toolCallId, use.input);
      if (event !== undefined) events.push(event);
    }

    return events;
  };
}
