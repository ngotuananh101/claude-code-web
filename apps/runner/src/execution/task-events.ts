/**
 * SDK task-lifecycle frames → typed journal events.
 *
 * The SDK emits five `system` frames describing background subagent/task work
 * (`task_started`, `task_progress`, `task_updated`, `task_notification`,
 * `background_tasks_changed`). Without this mapper the executor falls through
 * to `eventTypeOf` and journals all of them as an opaque `run.status`, so the
 * web client cannot tell that work is still running after the run's terminal
 * event. Mapping is pure: it reads the frame and returns the event to append.
 *
 * Payload hygiene: `prompt` never leaves the runner (it can be large and may
 * quote user content), and free text goes through the same redaction the rest
 * of the journal gets before it is persisted.
 */

import type { EventType } from "@cc-web/protocol";
import { redactErrorText } from "./redact.ts";

export type TaskJournalEvent = { type: EventType; payload: Record<string, unknown> };

/**
 * True for the five system frames this module understands — even when the
 * mapper rejects one as malformed. The executor uses this to keep a rejected
 * frame's `prompt` out of the generic fallback.
 */
export function isTaskLifecycleFrame(message: Record<string, unknown>): boolean {
  if (message["type"] !== "system") return false;
  switch (message["subtype"]) {
    case "task_started":
    case "task_progress":
    case "task_updated":
    case "task_notification":
    case "background_tasks_changed":
      return true;
    default:
      return false;
  }
}

/** null for every frame that is not a task-lifecycle system message. */
export function taskEventOf(message: Record<string, unknown>): TaskJournalEvent | null {
  if (!isTaskLifecycleFrame(message)) return null;
  switch (message["subtype"]) {
    case "task_started":
      return startedOf(message);
    case "task_progress":
      return progressOf(message);
    case "task_updated":
      return updatedOf(message);
    case "task_notification":
      return notificationOf(message);
    case "background_tasks_changed":
      return tasksChangedOf(message);
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Copy only defined values, so no `undefined` key reaches the payload. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function putRedacted(
  target: Record<string, unknown>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined) target[key] = redactErrorText(value);
}

function taskIdOf(message: Record<string, unknown>): string | undefined {
  const taskId = asString(message["task_id"]);
  return taskId === undefined || taskId === "" ? undefined : taskId;
}

function asUsage(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const totalTokens = asNumber(value["total_tokens"]);
  const toolUses = asNumber(value["tool_uses"]);
  const durationMs = asNumber(value["duration_ms"]);
  if (totalTokens === undefined || toolUses === undefined || durationMs === undefined) {
    return undefined;
  }
  return { totalTokens, toolUses, durationMs };
}

function startedOf(message: Record<string, unknown>): TaskJournalEvent | null {
  const taskId = taskIdOf(message);
  if (taskId === undefined) return null;
  const payload: Record<string, unknown> = {
    taskId,
    description: redactErrorText(asString(message["description"]) ?? ""),
  };
  put(payload, "runId", asString(message["run_id"]));
  put(payload, "toolUseId", asString(message["tool_use_id"]));
  put(payload, "subagentType", asString(message["subagent_type"]));
  put(payload, "isBackgrounded", asBoolean(message["is_backgrounded"]));
  put(payload, "spawnDepth", asNumber(message["spawn_depth"]));
  put(payload, "parentTaskId", asString(message["parent_task_id"]));
  put(payload, "taskType", asString(message["task_type"]));
  put(payload, "workflowName", asString(message["workflow_name"]));
  put(payload, "ambient", asBoolean(message["ambient"]));
  put(payload, "skipTranscript", asBoolean(message["skip_transcript"]));
  return { type: "task.started", payload };
}

function progressOf(message: Record<string, unknown>): TaskJournalEvent | null {
  const taskId = taskIdOf(message);
  if (taskId === undefined) return null;
  const payload: Record<string, unknown> = { taskId };
  put(payload, "runId", asString(message["run_id"]));
  put(payload, "toolUseId", asString(message["tool_use_id"]));
  putRedacted(payload, "description", asString(message["description"]));
  put(payload, "subagentType", asString(message["subagent_type"]));
  put(payload, "usage", asUsage(message["usage"]));
  putRedacted(payload, "lastToolName", asString(message["last_tool_name"]));
  putRedacted(payload, "summary", asString(message["summary"]));
  return { type: "task.progress", payload };
}

function updatedOf(message: Record<string, unknown>): TaskJournalEvent | null {
  const taskId = taskIdOf(message);
  if (taskId === undefined) return null;
  const patchValue = message["patch"];
  if (!isRecord(patchValue)) return null;
  const patch: Record<string, unknown> = {};
  put(patch, "status", asString(patchValue["status"]));
  putRedacted(patch, "description", asString(patchValue["description"]));
  put(patch, "endTime", asNumber(patchValue["end_time"]));
  put(patch, "totalPausedMs", asNumber(patchValue["total_paused_ms"]));
  putRedacted(patch, "error", asString(patchValue["error"]));
  put(patch, "isBackgrounded", asBoolean(patchValue["is_backgrounded"]));
  const payload: Record<string, unknown> = { taskId, patch };
  put(payload, "runId", asString(message["run_id"]));
  return { type: "task.updated", payload };
}

function notificationOf(message: Record<string, unknown>): TaskJournalEvent | null {
  const status = message["status"];
  if (status !== "completed" && status !== "failed" && status !== "stopped") return null;
  const taskId = taskIdOf(message);
  if (taskId === undefined) return null;
  const payload: Record<string, unknown> = { taskId, status };
  put(payload, "runId", asString(message["run_id"]));
  put(payload, "toolUseId", asString(message["tool_use_id"]));
  putRedacted(payload, "summary", asString(message["summary"]));
  put(payload, "outputFile", asString(message["output_file"]));
  if (message["reason"] === "worker_restart") payload["reason"] = "worker_restart";
  put(payload, "usage", asUsage(message["usage"]));
  put(payload, "ambient", asBoolean(message["ambient"]));
  put(payload, "skipTranscript", asBoolean(message["skip_transcript"]));
  return { type: "task.completed", payload };
}

function tasksChangedOf(message: Record<string, unknown>): TaskJournalEvent | null {
  const tasksValue = message["tasks"];
  if (!Array.isArray(tasksValue)) return null;
  const tasks: Record<string, unknown>[] = [];
  for (const entry of tasksValue) {
    if (!isRecord(entry)) continue;
    const taskId = taskIdOf(entry);
    if (taskId === undefined) continue;
    const ref: Record<string, unknown> = { taskId };
    put(ref, "runId", asString(entry["run_id"]));
    put(ref, "taskType", asString(entry["task_type"]));
    put(ref, "subagentType", asString(entry["subagent_type"]));
    put(ref, "parentTaskId", asString(entry["parent_task_id"]));
    put(ref, "ambient", asBoolean(entry["ambient"]));
    tasks.push(ref);
  }
  return { type: "tasks.changed", payload: { tasks } };
}
