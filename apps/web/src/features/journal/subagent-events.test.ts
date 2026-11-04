import { describe, expect, test } from "bun:test";
import type { BrowserReplayEvent, SessionMessage } from "@cc-web/protocol";
import { EMPTY_TASK_STATE, taskStateFromEvents } from "./background-tasks.ts";
import {
  deriveSubagentItems,
  resolveSelectedSubagentId,
  type SubagentItem,
  summarizeSubagentCounts,
} from "./subagent-events.ts";

let seq = 0;
function liveEvent(
  type: string,
  payload: unknown,
  runId = "run-1",
  occurredAt?: string,
): BrowserReplayEvent {
  seq += 1;
  return {
    sessionSequence: seq,
    eventId: `evt-${seq}`,
    runId,
    attemptId: "attempt-1",
    occurredAt: occurredAt ?? `2026-10-25T00:00:${String(seq).padStart(2, "0")}Z`,
    type: type as BrowserReplayEvent["type"],
    payload,
  };
}

function resetSeq(): void {
  seq = 0;
}

describe("deriveSubagentItems", () => {
  test("groups live subagent tool steps, deltas and summary under the spawning subagent", () => {
    resetSeq();
    const events: BrowserReplayEvent[] = [
      liveEvent("run.started", { prompt: "Audit and fix" }, "run-1", "2026-10-25T00:00:01Z"),
      liveEvent(
        "message.completed",
        {
          type: "assistant",
          parent_tool_use_id: null,
          message: {
            id: "msg-main-1",
            content: [
              {
                type: "tool_use",
                id: "toolu-sub-1",
                name: "Agent",
                input: {
                  description: "Audit runner handlers",
                  subagent_type: "Explore",
                  prompt: "Inspect apps/runner/src/sessions/handler.ts",
                },
              },
            ],
          },
        },
        "run-1",
        "2026-10-25T00:00:02Z",
      ),
      liveEvent(
        "tool.started",
        { toolCallId: "toolu-sub-1", toolName: "Agent" },
        "run-1",
        "2026-10-25T00:00:02Z",
      ),
      liveEvent(
        "task.started",
        {
          taskId: "task-sub-1",
          runId: "run-1",
          toolUseId: "toolu-sub-1",
          description: "Audit runner handlers",
          subagentType: "Explore",
        },
        "run-1",
        "2026-10-25T00:00:03Z",
      ),
      liveEvent(
        "message.completed",
        {
          type: "assistant",
          parent_tool_use_id: "toolu-sub-1",
          message: {
            id: "msg-sub-1",
            content: [
              { type: "thinking", thinking: "Checking session handler first" },
              {
                type: "tool_use",
                id: "t-sub-read",
                name: "Read",
                input: { file_path: "apps/runner/src/sessions/handler.ts" },
              },
              {
                type: "tool_use",
                id: "t-sub-write",
                name: "Write",
                input: { file_path: "apps/runner/src/sessions/notes.md", content: "ok" },
              },
              {
                type: "tool_use",
                id: "t-sub-bash",
                name: "Bash",
                input: { command: "bun test apps/runner" },
              },
            ],
          },
        },
        "run-1",
        "2026-10-25T00:00:04Z",
      ),
      liveEvent(
        "tool.started",
        { toolCallId: "t-sub-read", toolName: "Read", parentToolUseId: "toolu-sub-1" },
        "run-1",
        "2026-10-25T00:00:04Z",
      ),
      liveEvent(
        "tool.completed",
        {
          toolCallId: "t-sub-read",
          isError: false,
          outputSummary: "235 lines",
          parentToolUseId: "toolu-sub-1",
        },
        "run-1",
        "2026-10-25T00:00:05Z",
      ),
      liveEvent(
        "tool.started",
        { toolCallId: "t-sub-write", toolName: "Write", parentToolUseId: "toolu-sub-1" },
        "run-1",
        "2026-10-25T00:00:05Z",
      ),
      liveEvent(
        "tool.completed",
        {
          toolCallId: "t-sub-write",
          isError: false,
          outputSummary: "File written",
          parentToolUseId: "toolu-sub-1",
        },
        "run-1",
        "2026-10-25T00:00:06Z",
      ),
      liveEvent(
        "tool.started",
        { toolCallId: "t-sub-bash", toolName: "Bash", parentToolUseId: "toolu-sub-1" },
        "run-1",
        "2026-10-25T00:00:06Z",
      ),
      liveEvent(
        "message.started",
        { messageId: "msg-sub-2", parentToolUseId: "toolu-sub-1" },
        "run-1",
        "2026-10-25T00:00:07Z",
      ),
      liveEvent(
        "message.delta",
        {
          messageId: "msg-sub-2",
          text: "Running test suite now...",
          parentToolUseId: "toolu-sub-1",
        },
        "run-1",
        "2026-10-25T00:00:08Z",
      ),
    ];

    const taskState = taskStateFromEvents(events);
    const items = deriveSubagentItems([], events, taskState);

    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.taskId).toBe("task-sub-1");
    expect(item.toolUseId).toBe("toolu-sub-1");
    expect(item.description).toBe("Audit runner handlers");
    expect(item.subagentType).toBe("Explore");
    expect(item.status).toBe("running");

    const toolEvents = item.events.filter((e) => e.kind === "tool");
    expect(toolEvents).toHaveLength(3);
    expect(toolEvents[0]!.step).toMatchObject({
      toolName: "Read",
      filePath: "apps/runner/src/sessions/handler.ts",
      state: "done",
      outputSummary: "235 lines",
    });
    expect(toolEvents[1]!.step).toMatchObject({
      toolName: "Write",
      filePath: "apps/runner/src/sessions/notes.md",
      state: "done",
      outputSummary: "File written",
    });
    expect(toolEvents[2]!.step).toMatchObject({
      toolName: "Bash",
      command: "bun test apps/runner",
      state: "running",
    });

    const textEvents = item.events.filter((e) => e.kind === "text");
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]!.text).toBe("Running test suite now...");
  });

  test("reconstructs subagents and events from historical SessionMessages on session resume", () => {
    const history: SessionMessage[] = [
      {
        type: "user",
        uuid: "u-1",
        message: { content: "Explore the web app" },
      },
      {
        type: "assistant",
        uuid: "a-1",
        message: {
          type: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu-hist-1",
              name: "Agent",
              input: {
                description: "Find Vue components",
                subagent_type: "Explore",
                prompt: "List Vue components",
              },
            },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "a-sub-1",
        parentToolUseId: "toolu-hist-1",
        message: {
          type: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t-hist-glob",
              name: "Glob",
              input: { pattern: "apps/web/src/**/*.vue" },
            },
            {
              type: "tool_use",
              id: "t-hist-edit",
              name: "Edit",
              input: {
                file_path: "apps/web/src/App.vue",
                old_string: "foo",
                new_string: "bar\nbaz",
              },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "u-sub-1",
        parentToolUseId: "toolu-hist-1",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t-hist-glob", content: "Composer.vue\nApp.vue" },
            { type: "tool_result", tool_use_id: "t-hist-edit", content: "Updated" },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "a-sub-2",
        parentToolUseId: "toolu-hist-1",
        message: {
          type: "assistant",
          content: [{ type: "text", text: "Found Composer.vue and App.vue." }],
        },
      },
      {
        type: "user",
        uuid: "u-main-res",
        message: {
          type: "tool_result",
          tool_use_id: "toolu-hist-1",
          content: "Found Composer.vue and App.vue.",
        },
      },
    ];

    const items = deriveSubagentItems(history, [], EMPTY_TASK_STATE);
    expect(items).toHaveLength(1);
    const sub = items[0]!;
    expect(sub.toolUseId).toBe("toolu-hist-1");
    expect(sub.description).toBe("Find Vue components");
    expect(sub.subagentType).toBe("Explore");
    expect(sub.status).toBe("completed");
    expect(sub.summary).toBe("Found Composer.vue and App.vue.");

    const tools = sub.events.filter((e) => e.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]!.step).toMatchObject({
      toolName: "Glob",
      inputSummary: "apps/web/src/**/*.vue",
      state: "done",
      outputSummary: "Composer.vue\nApp.vue",
    });
    expect(tools[1]!.step).toMatchObject({
      toolName: "Edit",
      filePath: "apps/web/src/App.vue",
      diffStats: { added: 2, removed: 1 },
      state: "done",
      outputSummary: "Updated",
    });
  });

  test("ignores ambient and skipTranscript housekeeping tasks", () => {
    resetSeq();
    const events: BrowserReplayEvent[] = [
      liveEvent("task.started", {
        taskId: "task-ambient",
        description: "Housekeeping",
        ambient: true,
      }),
      liveEvent("task.started", {
        taskId: "task-skip",
        description: "Skip me",
        skipTranscript: true,
      }),
      liveEvent("task.started", {
        taskId: "task-real",
        description: "Real subagent",
        subagentType: "general-purpose",
      }),
    ];

    const items = deriveSubagentItems([], events, taskStateFromEvents(events));
    expect(items).toHaveLength(1);
    expect(items[0]!.taskId).toBe("task-real");
  });
});

describe("summarizeSubagentCounts and resolveSelectedSubagentId", () => {
  const mkItem = (partial: Partial<SubagentItem> & { id: string }): SubagentItem => ({
    description: partial.id,
    status: "running",
    events: [],
    ...partial,
  });

  test("counts running, completed, failed, and stopped subagents", () => {
    const counts = summarizeSubagentCounts([
      mkItem({ id: "a", status: "running" }),
      mkItem({ id: "b", status: "running" }),
      mkItem({ id: "c", status: "completed" }),
      mkItem({ id: "d", status: "failed" }),
      mkItem({ id: "e", status: "stopped" }),
    ]);

    expect(counts).toEqual({
      total: 5,
      running: 2,
      completed: 1,
      failed: 1,
      stopped: 1,
    });
  });

  test("resolves selected subagent by id, taskId, or toolUseId and falls back to running or first", () => {
    const list = [
      mkItem({ id: "sub-1", taskId: "task-1", toolUseId: "toolu-1", status: "completed" }),
      mkItem({ id: "sub-2", taskId: "task-2", toolUseId: "toolu-2", status: "running" }),
    ];

    expect(resolveSelectedSubagentId(list, "toolu-1")).toBe("sub-1");
    expect(resolveSelectedSubagentId(list, "task-2")).toBe("sub-2");
    // When nothing selected (or stale), prefers first running subagent, otherwise first item
    expect(resolveSelectedSubagentId(list, null)).toBe("sub-2");
    expect(
      resolveSelectedSubagentId([mkItem({ id: "only-done", status: "completed" })], null),
    ).toBe("only-done");
    expect(resolveSelectedSubagentId([], null)).toBeNull();
  });
});
