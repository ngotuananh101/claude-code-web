import { describe, expect, test } from "bun:test";
import {
  applyTaskEvent,
  type BackgroundTaskState,
  EMPTY_TASK_STATE,
  formatTaskElapsed,
  taskStateFromEvents,
} from "./background-tasks.ts";

const at = (n: number) => `2026-11-01T00:00:0${n}.000Z`;

/** The live set, sorted so assertions do not depend on insertion order. */
function liveIds(state: BackgroundTaskState): string[] {
  return [...state.liveTaskIds].sort();
}

describe("background task state", () => {
  test("started adds a live task; tasks.changed replaces the live set", () => {
    let state = applyTaskEvent(EMPTY_TASK_STATE, {
      type: "task.started",
      occurredAt: at(1),
      payload: { taskId: "a", description: "Sweep", subagentType: "Explore", ambient: false },
    });
    expect(liveIds(state)).toEqual(["a"]);

    state = applyTaskEvent(state, {
      type: "tasks.changed",
      occurredAt: at(2),
      payload: { tasks: [] },
    });
    expect(liveIds(state)).toEqual([]);
  });

  test("an edge that never got its completion cannot survive a level reset", () => {
    const state = taskStateFromEvents([
      {
        type: "task.started",
        occurredAt: at(1),
        payload: { taskId: "a", description: "Sweep" },
      },
      { type: "tasks.changed", occurredAt: at(2), payload: { tasks: [] } },
    ]);
    // The task row survives for history, but nothing is live.
    expect(state.tasks.has("a")).toBe(true);
    expect(liveIds(state)).toEqual([]);
  });

  test("progress and completion update the row", () => {
    let state = applyTaskEvent(EMPTY_TASK_STATE, {
      type: "task.started",
      occurredAt: at(1),
      payload: { taskId: "a", description: "Sweep", ambient: false },
    });
    state = applyTaskEvent(state, {
      type: "task.progress",
      occurredAt: at(2),
      payload: { taskId: "a", lastToolName: "Bash", summary: "working" },
    });
    expect(state.tasks.get("a")?.lastToolName).toBe("Bash");

    state = applyTaskEvent(state, {
      type: "task.completed",
      occurredAt: at(3),
      payload: {
        taskId: "a",
        status: "completed",
        summary: "done",
        usage: { totalTokens: 120, toolUses: 2, durationMs: 3000 },
      },
    });
    const task = state.tasks.get("a");
    expect(task?.status).toBe("completed");
    expect(task?.summary).toBe("done");
    expect(task?.usage).toEqual({ totalTokens: 120, toolUses: 2, durationMs: 3000 });
    expect(liveIds(state)).toEqual([]);
  });

  test("the ambient flag is recorded on the row", () => {
    // Liveness is the reducer's business; whether a task is shown at all was
    // the band's, and the band is gone — the spawning badge filters by the
    // tool-use join instead. The flag still has to travel.
    const state = applyTaskEvent(EMPTY_TASK_STATE, {
      type: "task.started",
      occurredAt: at(1),
      payload: { taskId: "a", description: "Watcher", ambient: true },
    });
    expect(state.tasks.has("a")).toBe(true);
    expect(state.tasks.get("a")?.ambient).toBe(true);
  });

  test("progress records the runId so a later older-run frame is ignored", () => {
    // The level signal can register a task before any edge names its run. The
    // first frame that does name it must be remembered, or the late-frame
    // guard has nothing to compare against.
    let state = applyTaskEvent(EMPTY_TASK_STATE, {
      type: "tasks.changed",
      occurredAt: at(1),
      payload: { tasks: [{ taskId: "a" }] },
    });
    state = applyTaskEvent(state, {
      type: "task.progress",
      occurredAt: at(2),
      payload: { taskId: "a", runId: "run-2", lastToolName: "Bash" },
    });
    expect(state.tasks.get("a")?.runId).toBe("run-2");

    const settled = state;
    state = applyTaskEvent(state, {
      type: "task.updated",
      occurredAt: at(3),
      payload: { taskId: "a", runId: "run-1", patch: { status: "failed" } },
    });
    expect(state).toBe(settled);
    expect(state.tasks.get("a")?.status).toBe("running");
  });

  test("completion records a runId the level signal did not carry", () => {
    let state = applyTaskEvent(EMPTY_TASK_STATE, {
      type: "tasks.changed",
      occurredAt: at(1),
      payload: { tasks: [{ taskId: "a" }] },
    });
    state = applyTaskEvent(state, {
      type: "task.completed",
      occurredAt: at(2),
      payload: { taskId: "a", runId: "run-2", status: "completed" },
    });
    expect(state.tasks.get("a")?.runId).toBe("run-2");
  });

  test("the skip-transcript flag is recorded on the row", () => {
    const state = applyTaskEvent(EMPTY_TASK_STATE, {
      type: "task.started",
      occurredAt: at(1),
      payload: { taskId: "a", description: "Watcher", skipTranscript: true, ambient: false },
    });
    expect(state.tasks.has("a")).toBe(true);
    expect(state.tasks.get("a")?.skipTranscript).toBe(true);
  });

  test("a late update from an older run is ignored", () => {
    let state = applyTaskEvent(EMPTY_TASK_STATE, {
      type: "task.started",
      occurredAt: at(1),
      payload: { taskId: "a", runId: "run-2", description: "Sweep" },
    });
    const held = state.tasks.get("a");
    state = applyTaskEvent(state, {
      type: "task.progress",
      occurredAt: at(2),
      payload: { taskId: "a", runId: "run-1", lastToolName: "Bash" },
    });
    expect(state.tasks.get("a")).toBe(held);
  });

  test("unknown events keep the state object identity", () => {
    const state = applyTaskEvent(EMPTY_TASK_STATE, {
      type: "run.status",
      occurredAt: at(3),
      payload: {},
    });
    expect(state).toBe(EMPTY_TASK_STATE);
  });

  test("an unparsable task payload keeps the state object identity", () => {
    const state = applyTaskEvent(EMPTY_TASK_STATE, {
      type: "task.started",
      occurredAt: at(3),
      payload: {},
    });
    expect(state).toBe(EMPTY_TASK_STATE);
  });

  test("elapsed labels stay compact and never go negative", () => {
    expect(formatTaskElapsed(8_000)).toBe("8s");
    expect(formatTaskElapsed(185_000)).toBe("3p 05s");
    expect(formatTaskElapsed(3_930_000)).toBe("1g 05p");
    expect(formatTaskElapsed(-5_000)).toBe("0s");
  });
});
