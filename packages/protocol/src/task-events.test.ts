import { describe, expect, test } from "bun:test";
import {
  parseTaskCompletedPayload,
  parseTaskStartedPayload,
  parseTasksChangedPayload,
} from "./task-events.ts";

describe("task payload parsers", () => {
  test("started keeps the UI fields and rejects a missing taskId", () => {
    const parsed = parseTaskStartedPayload({
      taskId: "task-1",
      runId: "run-2",
      toolUseId: "toolu-9",
      description: "Sweep the repo",
      subagentType: "Explore",
      isBackgrounded: true,
      spawnDepth: 1,
      ambient: false,
    });
    expect(parsed).toEqual({
      taskId: "task-1",
      runId: "run-2",
      toolUseId: "toolu-9",
      description: "Sweep the repo",
      subagentType: "Explore",
      isBackgrounded: true,
      spawnDepth: 1,
      ambient: false,
    });
    expect(parseTaskStartedPayload({ description: "no id" })).toBeNull();
    expect(parseTaskStartedPayload(null)).toBeNull();
  });

  test("completed narrows status and keeps usage", () => {
    expect(
      parseTaskCompletedPayload({
        taskId: "task-1",
        status: "stopped",
        summary: "stopped by operator",
        usage: { totalTokens: 1200, toolUses: 4, durationMs: 9000 },
      }),
    ).toEqual({
      taskId: "task-1",
      status: "stopped",
      summary: "stopped by operator",
      usage: { totalTokens: 1200, toolUses: 4, durationMs: 9000 },
    });
    expect(parseTaskCompletedPayload({ taskId: "task-1", status: "bogus" })).toBeNull();
  });

  test("tasks.changed is a level set with the same ref shape", () => {
    expect(
      parseTasksChangedPayload({
        tasks: [
          { taskId: "a", ambient: false },
          { taskId: "b", parentTaskId: "a" },
        ],
      }),
    ).toEqual({
      tasks: [
        { taskId: "a", ambient: false },
        { taskId: "b", parentTaskId: "a" },
      ],
    });
    expect(parseTasksChangedPayload({ tasks: "nope" })).toBeNull();
  });
});
