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

  test("captures live subagent tool calls from message.completed + tool.completed even when SDK emits no stream_event tool.started, and builds AgentTurn segments", () => {
    resetSeq();
    const events: BrowserReplayEvent[] = [
      liveEvent(
        "task.started",
        {
          taskId: "agent-live-no-stream",
          runId: "run-1",
          toolUseId: "toolu-parent-1",
          description: "Inspect components",
          subagentType: "Explore",
        },
        "run-1",
        "2026-10-25T00:00:01Z",
      ),
      // Real Claude Code subagents emit complete assistant/user frames without stream_event tool.started
      liveEvent(
        "message.completed",
        {
          type: "assistant",
          parent_tool_use_id: "toolu-parent-1",
          agent_id: "agent-live-no-stream",
          message: {
            id: "msg-sub-complete-1",
            content: [
              { type: "thinking", thinking: "Need to read ModelPickerPopover.vue" },
              {
                type: "tool_use",
                id: "toolu-sub-read-only-complete",
                name: "Read",
                input: { file_path: "apps/web/src/components/ModelPickerPopover.vue" },
              },
            ],
          },
        },
        "run-1",
        "2026-10-25T00:00:02Z",
      ),
      liveEvent(
        "tool.completed",
        {
          toolCallId: "toolu-sub-read-only-complete",
          isError: false,
          outputSummary: "475 lines",
          parentToolUseId: "toolu-parent-1",
          agentId: "agent-live-no-stream",
        },
        "run-1",
        "2026-10-25T00:00:03Z",
      ),
      liveEvent(
        "message.completed",
        {
          type: "assistant",
          parent_tool_use_id: "toolu-parent-1",
          agent_id: "agent-live-no-stream",
          message: {
            id: "msg-sub-complete-2",
            content: [{ type: "text", text: "## Summary\nWrap both popovers in `ScrollArea`." }],
          },
        },
        "run-1",
        "2026-10-25T00:00:04Z",
      ),
      liveEvent(
        "task.completed",
        {
          taskId: "agent-live-no-stream",
          runId: "run-1",
          status: "completed",
          usage: { totalTokens: 4200, toolUses: 1, durationMs: 3000 },
        },
        "run-1",
        "2026-10-25T00:00:05Z",
      ),
    ];

    const items = deriveSubagentItems([], events, taskStateFromEvents(events));
    expect(items).toHaveLength(1);
    const sub = items[0]!;
    expect(sub.status).toBe("completed");
    const tools = sub.events.filter((e) => e.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.step).toMatchObject({
      toolCallId: "toolu-sub-read-only-complete",
      toolName: "Read",
      filePath: "apps/web/src/components/ModelPickerPopover.vue",
      state: "done",
      outputSummary: "475 lines",
    });

    const agentTurn = sub.turns.find((t) => t.kind === "agent");
    expect(agentTurn).toBeDefined();
    expect(agentTurn?.kind === "agent" && agentTurn.status).toBe("done");
    expect(agentTurn?.kind === "agent" && agentTurn.steps).toHaveLength(2);
    expect(agentTurn?.kind === "agent" && agentTurn.text).toContain("Wrap both popovers");
  });

  test("correlates Workflow subagents by agentId in both live frames (parent_tool_use_id: null) and historical Workflow tool_result + subagent transcripts", () => {
    resetSeq();
    const history: SessionMessage[] = [
      {
        type: "assistant",
        uuid: "main-wf-call",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu-wf-1",
              name: "Workflow",
              input: { script: "export const meta = { name: 'audit' }" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "main-wf-res",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-wf-1",
              content: JSON.stringify({
                summary: "Audit workflow",
                workflowProgress: [
                  {
                    type: "workflow_agent",
                    agentId: "ae3454d16c5171399",
                    label: "investigate:scrollarea",
                    phaseTitle: "Investigate",
                    state: "done",
                    tokens: 18715,
                    toolCalls: 2,
                    durationMs: 14000,
                  },
                ],
              }),
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "wf-sub-prompt",
        agentId: "ae3454d16c5171399",
        message: { role: "user", content: "Check ScrollArea.vue" },
      },
      {
        type: "assistant",
        uuid: "wf-sub-step",
        agentId: "ae3454d16c5171399",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu-wf-read-1",
              name: "Read",
              input: { file_path: "apps/web/src/components/ui/scroll-area/ScrollArea.vue" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "wf-sub-tool-res",
        agentId: "ae3454d16c5171399",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu-wf-read-1", content: "29 lines" }],
        },
      },
    ];

    const items = deriveSubagentItems(history, [], EMPTY_TASK_STATE);
    expect(items).toHaveLength(1);
    const wfSub = items[0]!;
    expect(wfSub.taskId).toBe("ae3454d16c5171399");
    expect(wfSub.description).toBe("investigate:scrollarea");
    expect(wfSub.workflowName).toBe("Investigate");
    expect(wfSub.status).toBe("completed");
    expect(wfSub.usage).toEqual({ totalTokens: 18715, toolUses: 2, durationMs: 14000 });
    expect(wfSub.events.filter((e) => e.kind === "tool")).toHaveLength(1);
    expect(wfSub.turns.map((t) => t.kind)).toEqual(["user", "agent"]);

    // Also verify replayed live events where a legacy tool.completed lacks agentId/parentToolUseId
    // still resolves the subagent tool step by its globally unique toolCallId:
    const liveWfEvents: BrowserReplayEvent[] = [
      liveEvent("task.started", {
        taskId: "wf-live-1",
        runId: "run-wf",
        description: "investigate:subagent",
        workflowName: "Investigate",
        subagentType: "workflow-subagent",
      }),
      liveEvent("message.completed", {
        type: "assistant",
        parent_tool_use_id: null,
        agent_id: "wf-live-1",
        message: {
          id: "msg-wf-live-1",
          content: [
            {
              type: "tool_use",
              id: "toolu-wf-legacy-1",
              name: "Read",
              input: { file_path: "apps/web/src/components/chat/SubagentListDialog.vue" },
            },
          ],
        },
      }),
      // Legacy tool.completed in journal before agentId was extracted on tool-results:
      liveEvent("tool.completed", {
        toolCallId: "toolu-wf-legacy-1",
        isError: false,
        outputSummary: "405 lines",
      }),
    ];
    const liveWfItems = deriveSubagentItems([], liveWfEvents, taskStateFromEvents(liveWfEvents));
    expect(liveWfItems).toHaveLength(1);
    const liveWfStep = liveWfItems[0]!.events.find((e) => e.kind === "tool");
    expect(liveWfStep?.kind === "tool" && liveWfStep.step).toMatchObject({
      toolCallId: "toolu-wf-legacy-1",
      state: "done",
      outputSummary: "405 lines",
    });
  });

  test("populates AgentTurn prose from task summary when subagent emitted tool steps without a separate text message", () => {
    resetSeq();
    const events: BrowserReplayEvent[] = [
      liveEvent("task.started", {
        taskId: "sub-summary-fallback",
        runId: "run-1",
        toolUseId: "toolu-sum-1",
        description: "Quick file check",
        subagentType: "Explore",
      }),
      liveEvent("message.completed", {
        type: "assistant",
        parent_tool_use_id: "toolu-sum-1",
        agent_id: "sub-summary-fallback",
        message: {
          id: "msg-sum-1",
          content: [
            {
              type: "tool_use",
              id: "toolu-sum-read",
              name: "Read",
              input: { file_path: "README.md" },
            },
          ],
        },
      }),
      liveEvent("tool.completed", {
        toolCallId: "toolu-sum-read",
        isError: false,
        outputSummary: "10 lines",
        parentToolUseId: "toolu-sum-1",
        agentId: "sub-summary-fallback",
      }),
      liveEvent("task.completed", {
        taskId: "sub-summary-fallback",
        runId: "run-1",
        status: "completed",
        summary: "README verified.",
      }),
    ];

    const items = deriveSubagentItems([], events, taskStateFromEvents(events));
    const turn = items[0]?.turns.find((t) => t.kind === "agent");
    expect(turn?.kind === "agent" && turn.text).toBe("README verified.");
    expect(turn?.kind === "agent" && turn.segments.map((s) => s.kind)).toEqual(["process", "text"]);
  });
});

describe("summarizeSubagentCounts and resolveSelectedSubagentId", () => {
  const mkItem = (partial: Partial<SubagentItem> & { id: string }): SubagentItem => ({
    description: partial.id,
    status: "running",
    events: [],
    turns: [],
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
