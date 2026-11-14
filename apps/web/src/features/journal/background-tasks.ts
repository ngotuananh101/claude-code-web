/**
 * Background task state for the journal.
 *
 * The SDK's level signal (`tasks.changed`) is authoritative for "is background
 * work running": we replace `liveTaskIds` on every one of them rather than
 * pairing start/end edges, so a missed `task.completed` cannot leave a stale
 * running indicator. The edges still build the row — description, last tool,
 * usage, final status — and serve as a fallback for when the level signal has
 * not arrived yet.
 *
 * The reducer is pure: an unparsable or unrelated event returns the same state
 * object, so a Vue computed derived from it does not churn.
 */

import {
  type EventType,
  parseTaskCompletedPayload,
  parseTaskProgressPayload,
  parseTaskStartedPayload,
  parseTasksChangedPayload,
  parseTaskUpdatedPayload,
  type TaskUsage,
} from "@cc-web/protocol";

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped";

export type BackgroundTask = {
  taskId: string;
  /** Needed to ignore a frame that names an older run (the SDK's ordering note). */
  runId?: string;
  description: string;
  subagentType?: string;
  taskType?: string;
  workflowName?: string;
  parentTaskId?: string;
  toolUseId?: string;
  ambient: boolean;
  /** Housekeeping task the SDK says belongs outside the transcript (§ ambient). */
  skipTranscript?: boolean;
  status: BackgroundTaskStatus;
  lastToolName?: string;
  summary?: string;
  usage?: TaskUsage;
  /** The journal envelope's `occurredAt` of the `task.started` frame. */
  startedAt: string;
  updatedAt: string;
};

export type BackgroundTaskState = {
  tasks: ReadonlyMap<string, BackgroundTask>;
  liveTaskIds: ReadonlySet<string>;
};

export const EMPTY_TASK_STATE: BackgroundTaskState = {
  tasks: new Map(),
  liveTaskIds: new Set(),
};

type TaskEvent = { type: EventType; payload: unknown; occurredAt: string };

/**
 * A frame carrying an older `runId` than the row it targets is late: `runId`s
 * sort in the order runs opened, so plain string comparison is enough.
 */
function isLate(incomingRunId: string | undefined, held: BackgroundTask | undefined): boolean {
  if (incomingRunId === undefined || held?.runId === undefined) return false;
  return incomingRunId < held.runId;
}

function statusOfPatch(
  status: "pending" | "running" | "completed" | "failed" | "killed" | "paused" | undefined,
): BackgroundTaskStatus | undefined {
  switch (status) {
    case "pending":
    case "running":
    case "paused":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
      // The SDK's "killed" is a task that was stopped, not one that failed.
      return "stopped";
    default:
      return undefined;
  }
}

/** Replace the row and set membership; the caller decided both. */
function withTask(
  state: BackgroundTaskState,
  task: BackgroundTask,
  live: boolean,
): BackgroundTaskState {
  const tasks = new Map(state.tasks);
  tasks.set(task.taskId, task);
  const liveTaskIds = new Set(state.liveTaskIds);
  if (live) {
    liveTaskIds.add(task.taskId);
  } else {
    liveTaskIds.delete(task.taskId);
  }
  return { tasks, liveTaskIds };
}

function applyStarted(
  state: BackgroundTaskState,
  payload: NonNullable<ReturnType<typeof parseTaskStartedPayload>>,
  occurredAt: string,
): BackgroundTaskState {
  const held = state.tasks.get(payload.taskId);
  if (isLate(payload.runId, held)) return state;
  const task: BackgroundTask = {
    taskId: payload.taskId,
    ...(payload.runId === undefined ? {} : { runId: payload.runId }),
    description: payload.description,
    ...(payload.subagentType === undefined ? {} : { subagentType: payload.subagentType }),
    ...(payload.taskType === undefined ? {} : { taskType: payload.taskType }),
    ...(payload.workflowName === undefined ? {} : { workflowName: payload.workflowName }),
    ...(payload.parentTaskId === undefined ? {} : { parentTaskId: payload.parentTaskId }),
    ...(payload.toolUseId === undefined ? {} : { toolUseId: payload.toolUseId }),
    ambient: payload.ambient ?? held?.ambient ?? false,
    ...(payload.skipTranscript === undefined ? {} : { skipTranscript: payload.skipTranscript }),
    status: "running",
    startedAt: held?.startedAt ?? occurredAt,
    updatedAt: occurredAt,
  };
  return withTask(state, task, true);
}

function applyProgress(
  state: BackgroundTaskState,
  payload: NonNullable<ReturnType<typeof parseTaskProgressPayload>>,
  occurredAt: string,
): BackgroundTaskState {
  const held = state.tasks.get(payload.taskId);
  if (isLate(payload.runId, held)) return state;
  const base: BackgroundTask = held ?? {
    taskId: payload.taskId,
    ...(payload.runId === undefined ? {} : { runId: payload.runId }),
    description: payload.description ?? "",
    ...(payload.subagentType === undefined ? {} : { subagentType: payload.subagentType }),
    ambient: false,
    status: "running",
    startedAt: occurredAt,
    updatedAt: occurredAt,
  };
  const task: BackgroundTask = {
    ...base,
    // The first frame that names the run is what the late-frame guard compares
    // against; dropping it here would leave the row with no ordering marker.
    ...(payload.runId === undefined ? {} : { runId: payload.runId }),
    ...(payload.description === undefined ? {} : { description: payload.description }),
    ...(payload.lastToolName === undefined ? {} : { lastToolName: payload.lastToolName }),
    ...(payload.summary === undefined ? {} : { summary: payload.summary }),
    ...(payload.usage === undefined ? {} : { usage: payload.usage }),
    updatedAt: occurredAt,
  };
  return withTask(state, task, task.status === "running");
}

function applyUpdated(
  state: BackgroundTaskState,
  payload: NonNullable<ReturnType<typeof parseTaskUpdatedPayload>>,
  occurredAt: string,
): BackgroundTaskState {
  const held = state.tasks.get(payload.taskId);
  if (isLate(payload.runId, held)) return state;
  const base: BackgroundTask = held ?? {
    taskId: payload.taskId,
    ...(payload.runId === undefined ? {} : { runId: payload.runId }),
    description: "",
    ambient: false,
    status: "running",
    startedAt: occurredAt,
    updatedAt: occurredAt,
  };
  const status = statusOfPatch(payload.patch.status);
  const task: BackgroundTask = {
    ...base,
    ...(payload.runId === undefined ? {} : { runId: payload.runId }),
    ...(payload.patch.description === undefined ? {} : { description: payload.patch.description }),
    ...(status === undefined ? {} : { status }),
    updatedAt: occurredAt,
  };
  return withTask(state, task, task.status === "running");
}

function applyCompleted(
  state: BackgroundTaskState,
  payload: NonNullable<ReturnType<typeof parseTaskCompletedPayload>>,
  occurredAt: string,
): BackgroundTaskState {
  const held = state.tasks.get(payload.taskId);
  if (isLate(payload.runId, held)) return state;
  const task: BackgroundTask = {
    ...(held ?? {
      taskId: payload.taskId,
      ...(payload.runId === undefined ? {} : { runId: payload.runId }),
      description: "",
      ambient: payload.ambient ?? false,
      status: "running",
      startedAt: occurredAt,
    }),
    status: payload.status,
    ...(payload.runId === undefined ? {} : { runId: payload.runId }),
    ...(payload.summary === undefined ? {} : { summary: payload.summary }),
    ...(payload.usage === undefined ? {} : { usage: payload.usage }),
    ...(payload.ambient === undefined ? {} : { ambient: payload.ambient }),
    ...(payload.skipTranscript === undefined ? {} : { skipTranscript: payload.skipTranscript }),
    updatedAt: occurredAt,
  };
  return withTask(state, task, false);
}

function applyTasksChanged(
  state: BackgroundTaskState,
  payload: NonNullable<ReturnType<typeof parseTasksChangedPayload>>,
  occurredAt: string,
): BackgroundTaskState {
  const tasks = new Map(state.tasks);
  for (const ref of payload.tasks) {
    const held = tasks.get(ref.taskId);
    if (isLate(ref.runId, held)) continue;
    const base: BackgroundTask = held ?? {
      taskId: ref.taskId,
      description: "",
      ambient: ref.ambient ?? false,
      status: "running",
      startedAt: occurredAt,
      updatedAt: occurredAt,
    };
    tasks.set(ref.taskId, {
      ...base,
      ...(ref.runId === undefined ? {} : { runId: ref.runId }),
      ...(ref.taskType === undefined ? {} : { taskType: ref.taskType }),
      ...(ref.subagentType === undefined ? {} : { subagentType: ref.subagentType }),
      ...(ref.parentTaskId === undefined ? {} : { parentTaskId: ref.parentTaskId }),
      ...(ref.ambient === undefined ? {} : { ambient: ref.ambient }),
      updatedAt: occurredAt,
    });
  }
  // The level signal replaces the live set; edges are only a fallback.
  const liveTaskIds = new Set(payload.tasks.map((ref) => ref.taskId));
  return { tasks, liveTaskIds };
}

export function applyTaskEvent(state: BackgroundTaskState, event: TaskEvent): BackgroundTaskState {
  switch (event.type) {
    case "task.started": {
      const payload = parseTaskStartedPayload(event.payload);
      return payload === null ? state : applyStarted(state, payload, event.occurredAt);
    }
    case "task.progress": {
      const payload = parseTaskProgressPayload(event.payload);
      return payload === null ? state : applyProgress(state, payload, event.occurredAt);
    }
    case "task.updated": {
      const payload = parseTaskUpdatedPayload(event.payload);
      return payload === null ? state : applyUpdated(state, payload, event.occurredAt);
    }
    case "task.completed": {
      const payload = parseTaskCompletedPayload(event.payload);
      return payload === null ? state : applyCompleted(state, payload, event.occurredAt);
    }
    case "tasks.changed": {
      const payload = parseTasksChangedPayload(event.payload);
      return payload === null ? state : applyTasksChanged(state, payload, event.occurredAt);
    }
    default:
      return state;
  }
}

export function taskStateFromEvents(events: ReadonlyArray<TaskEvent>): BackgroundTaskState {
  return events.reduce(applyTaskEvent, EMPTY_TASK_STATE);
}

/**
 * Compact elapsed label for a running task: `8s`, `3p 05s`, `1g 05p`.
 * A clock that went backwards (a skewed journal timestamp) clamps to zero.
 */
export function formatTaskElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}p ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}g ${String(minutes % 60).padStart(2, "0")}p`;
}
