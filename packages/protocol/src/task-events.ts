/**
 * Task lifecycle payloads.
 *
 * The SDK emits `task_started`, `task_progress`, `task_updated`,
 * `task_notification` and `background_tasks_changed` as `system` frames. The
 * runner normalises them into these camelCase payloads before journaling, and
 * the web client parses them back with the functions below. Journal payloads
 * are opaque JSON, so adding these types needs no database migration.
 */

export type TaskUsage = { totalTokens: number; toolUses: number; durationMs: number };

export type TaskRef = {
  taskId: string;
  runId?: string;
  taskType?: string;
  subagentType?: string;
  parentTaskId?: string;
  ambient?: boolean;
};

export type TaskStartedPayload = TaskRef & {
  toolUseId?: string;
  description: string;
  isBackgrounded?: boolean;
  spawnDepth?: number;
  workflowName?: string;
  skipTranscript?: boolean;
};

export type TaskProgressPayload = {
  taskId: string;
  runId?: string;
  toolUseId?: string;
  description?: string;
  subagentType?: string;
  usage?: TaskUsage;
  lastToolName?: string;
  summary?: string;
};

export type TaskUpdatedPayload = {
  taskId: string;
  runId?: string;
  patch: {
    status?: "pending" | "running" | "completed" | "failed" | "killed" | "paused";
    description?: string;
    endTime?: number;
    totalPausedMs?: number;
    error?: string;
    isBackgrounded?: boolean;
  };
};

export type TaskCompletedPayload = {
  taskId: string;
  runId?: string;
  toolUseId?: string;
  status: "completed" | "failed" | "stopped";
  reason?: "worker_restart";
  summary?: string;
  outputFile?: string;
  usage?: TaskUsage;
  ambient?: boolean;
  skipTranscript?: boolean;
};

export type TasksChangedPayload = { tasks: TaskRef[] };

const TASK_UPDATE_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "killed",
  "paused",
] as const;

type TaskUpdateStatus = (typeof TASK_UPDATE_STATUSES)[number];

const TASK_COMPLETED_STATUSES = ["completed", "failed", "stopped"] as const;

type TaskCompletedStatus = (typeof TASK_COMPLETED_STATUSES)[number];

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

function asUsage(value: unknown): TaskUsage | undefined {
  if (!isRecord(value)) return undefined;
  const totalTokens = asNumber(value["totalTokens"]);
  const toolUses = asNumber(value["toolUses"]);
  const durationMs = asNumber(value["durationMs"]);
  if (totalTokens === undefined || toolUses === undefined || durationMs === undefined) {
    return undefined;
  }
  return { totalTokens, toolUses, durationMs };
}

function asTaskUpdateStatus(value: unknown): TaskUpdateStatus | undefined {
  return typeof value === "string" && (TASK_UPDATE_STATUSES as readonly string[]).includes(value)
    ? (value as TaskUpdateStatus)
    : undefined;
}

function asTaskCompletedStatus(value: unknown): TaskCompletedStatus | undefined {
  return typeof value === "string" && (TASK_COMPLETED_STATUSES as readonly string[]).includes(value)
    ? (value as TaskCompletedStatus)
    : undefined;
}

/**
 * The shared gate for every edge payload: a record with a non-empty `taskId`.
 * Returns the pair so callers keep both the narrowing and the parsed id.
 */
function taskRecordOf(value: unknown): { record: Record<string, unknown>; taskId: string } | null {
  if (!isRecord(value)) return null;
  const taskId = asString(value["taskId"]);
  if (taskId === undefined || taskId === "") return null;
  return { record: value, taskId };
}

function copyStrings<T extends object>(
  target: T,
  record: Record<string, unknown>,
  keys: ReadonlyArray<readonly [keyof T & string, string]>,
): void {
  for (const [targetKey, sourceKey] of keys) {
    const value = asString(record[sourceKey]);
    if (value !== undefined) {
      (target as Record<string, unknown>)[targetKey] = value;
    }
  }
}

/** A `TaskRef` used by the level set; entries without a `taskId` are dropped. */
export function parseTaskRef(value: unknown): TaskRef | null {
  const parsed = taskRecordOf(value);
  if (parsed === null) return null;
  const { record, taskId } = parsed;
  const ref: TaskRef = { taskId };
  copyStrings(ref, record, [
    ["runId", "runId"],
    ["taskType", "taskType"],
    ["subagentType", "subagentType"],
    ["parentTaskId", "parentTaskId"],
  ]);
  const ambient = asBoolean(record["ambient"]);
  if (ambient !== undefined) ref.ambient = ambient;
  return ref;
}

export function parseTaskStartedPayload(value: unknown): TaskStartedPayload | null {
  const parsed = taskRecordOf(value);
  if (parsed === null) return null;
  const { record, taskId } = parsed;
  const payload: TaskStartedPayload = {
    taskId,
    description: asString(record["description"]) ?? "",
  };
  copyStrings(payload, record, [
    ["runId", "runId"],
    ["toolUseId", "toolUseId"],
    ["subagentType", "subagentType"],
    ["parentTaskId", "parentTaskId"],
    ["taskType", "taskType"],
    ["workflowName", "workflowName"],
  ]);
  const isBackgrounded = asBoolean(record["isBackgrounded"]);
  if (isBackgrounded !== undefined) payload.isBackgrounded = isBackgrounded;
  const spawnDepth = asNumber(record["spawnDepth"]);
  if (spawnDepth !== undefined) payload.spawnDepth = spawnDepth;
  const ambient = asBoolean(record["ambient"]);
  if (ambient !== undefined) payload.ambient = ambient;
  const skipTranscript = asBoolean(record["skipTranscript"]);
  if (skipTranscript !== undefined) payload.skipTranscript = skipTranscript;
  return payload;
}

export function parseTaskProgressPayload(value: unknown): TaskProgressPayload | null {
  const parsed = taskRecordOf(value);
  if (parsed === null) return null;
  const { record, taskId } = parsed;
  const payload: TaskProgressPayload = { taskId };
  copyStrings(payload, record, [
    ["runId", "runId"],
    ["toolUseId", "toolUseId"],
    ["description", "description"],
    ["subagentType", "subagentType"],
    ["lastToolName", "lastToolName"],
    ["summary", "summary"],
  ]);
  const usage = asUsage(record["usage"]);
  if (usage !== undefined) payload.usage = usage;
  return payload;
}

export function parseTaskUpdatedPayload(value: unknown): TaskUpdatedPayload | null {
  const parsed = taskRecordOf(value);
  if (parsed === null) return null;
  const { record, taskId } = parsed;
  const patchValue = record["patch"];
  if (!isRecord(patchValue)) return null;
  const patch: TaskUpdatedPayload["patch"] = {};
  const status = asTaskUpdateStatus(patchValue["status"]);
  if (status !== undefined) patch.status = status;
  const description = asString(patchValue["description"]);
  if (description !== undefined) patch.description = description;
  const endTime = asNumber(patchValue["endTime"]);
  if (endTime !== undefined) patch.endTime = endTime;
  const totalPausedMs = asNumber(patchValue["totalPausedMs"]);
  if (totalPausedMs !== undefined) patch.totalPausedMs = totalPausedMs;
  const error = asString(patchValue["error"]);
  if (error !== undefined) patch.error = error;
  const isBackgrounded = asBoolean(patchValue["isBackgrounded"]);
  if (isBackgrounded !== undefined) patch.isBackgrounded = isBackgrounded;
  const payload: TaskUpdatedPayload = { taskId, patch };
  const runId = asString(record["runId"]);
  if (runId !== undefined) payload.runId = runId;
  return payload;
}

export function parseTaskCompletedPayload(value: unknown): TaskCompletedPayload | null {
  const parsed = taskRecordOf(value);
  if (parsed === null) return null;
  const { record, taskId } = parsed;
  const status = asTaskCompletedStatus(record["status"]);
  if (status === undefined) return null;
  const payload: TaskCompletedPayload = { taskId, status };
  copyStrings(payload, record, [
    ["runId", "runId"],
    ["toolUseId", "toolUseId"],
    ["summary", "summary"],
    ["outputFile", "outputFile"],
  ]);
  if (record["reason"] === "worker_restart") payload.reason = "worker_restart";
  const usage = asUsage(record["usage"]);
  if (usage !== undefined) payload.usage = usage;
  const ambient = asBoolean(record["ambient"]);
  if (ambient !== undefined) payload.ambient = ambient;
  const skipTranscript = asBoolean(record["skipTranscript"]);
  if (skipTranscript !== undefined) payload.skipTranscript = skipTranscript;
  return payload;
}

export function parseTasksChangedPayload(value: unknown): TasksChangedPayload | null {
  if (!isRecord(value)) return null;
  const tasksValue = value["tasks"];
  if (!Array.isArray(tasksValue)) return null;
  const tasks: TaskRef[] = [];
  for (const entry of tasksValue) {
    const ref = parseTaskRef(entry);
    if (ref !== null) tasks.push(ref);
  }
  return { tasks };
}
