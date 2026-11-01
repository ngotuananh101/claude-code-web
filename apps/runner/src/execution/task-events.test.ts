import { describe, expect, test } from "bun:test";
import { taskEventOf } from "./task-events.ts";

describe("taskEventOf", () => {
  test("maps task_started to task.started and drops the prompt", () => {
    const event = taskEventOf({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      run_id: "run-2",
      tool_use_id: "toolu-9",
      description: "Sweep the repo",
      subagent_type: "Explore",
      is_backgrounded: true,
      spawn_depth: 1,
      parent_task_id: "task-0",
      task_type: "local_agent",
      workflow_name: "cc-web-smoke-sweep",
      prompt: "SECRET",
      ambient: false,
      uuid: "u-1",
      session_id: "s-1",
    });
    expect(event).toEqual({
      type: "task.started",
      payload: {
        taskId: "task-1",
        runId: "run-2",
        toolUseId: "toolu-9",
        description: "Sweep the repo",
        subagentType: "Explore",
        isBackgrounded: true,
        spawnDepth: 1,
        parentTaskId: "task-0",
        taskType: "local_agent",
        workflowName: "cc-web-smoke-sweep",
        ambient: false,
      },
    });
    expect(JSON.stringify(event)).not.toContain("SECRET");
  });

  test("maps notification status and redacts free text", () => {
    const event = taskEventOf({
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      status: "failed",
      summary: "failed with api_key=abcdef123456",
      output_file: "/tmp/task-1.txt",
      usage: { total_tokens: 10, tool_uses: 2, duration_ms: 500 },
    });
    expect(event?.type).toBe("task.completed");
    expect(event?.payload["summary"]).toContain("api_key=[REDACTED]");
    expect(event?.payload["status"]).toBe("failed");
  });

  test("background_tasks_changed replaces a level set", () => {
    const event = taskEventOf({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: "a", task_type: "local_agent", subagent_type: "Explore", ambient: false },
        { task_id: "b", ambient: true },
      ],
    });
    expect(event?.type).toBe("tasks.changed");
    expect(event?.payload).toEqual({
      tasks: [
        { taskId: "a", taskType: "local_agent", subagentType: "Explore", ambient: false },
        { taskId: "b", ambient: true },
      ],
    });
  });

  test("leaves unknown frames and malformed statuses on the generic path", () => {
    expect(taskEventOf({ type: "system", subtype: "init" })).toBeNull();
    expect(taskEventOf({ type: "assistant" })).toBeNull();
    expect(
      taskEventOf({ type: "system", subtype: "task_notification", task_id: "t", status: "weird" }),
    ).toBeNull();
  });
});
