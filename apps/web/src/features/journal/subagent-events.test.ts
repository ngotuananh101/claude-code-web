import { describe, expect, test } from "bun:test";
import type { BrowserReplayEvent, SessionMessage } from "@cc-web/protocol";
import { EMPTY_TASK_STATE, taskStateFromEvents } from "./background-tasks.ts";
import {
  deriveSubagentItems,
  filterHistorySubagents,
  filterVisibleSubagents,
  isSubagentVisibleByDefault,
  resolveSelectedSubagentId,
  resolveSubagentDialogTab,
  SUBAGENT_DEFAULT_VISIBILITY_MS,
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

const WORKFLOW_TOOL_USE_ID = "call_00_zlmqteg6c7sxiru8lyea2eej";
const WORKFLOW_RUN_ID = "wf_af8103d7-91f";

/**
 * The main transcript's half of a Workflow launch: the `Workflow` tool call and
 * its result. Verified against a live transcript — the result is plain launch
 * text, not JSON with a `workflowProgress` array (the SDK never emits that).
 */
function workflowLaunchMessages(): SessionMessage[] {
  return [
    {
      type: "assistant",
      uuid: "main-wf-call",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: WORKFLOW_TOOL_USE_ID,
            name: "Workflow",
            input: { script: "export const meta = { name: 'ytdlp-js-runtime-scout' }" },
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
            tool_use_id: WORKFLOW_TOOL_USE_ID,
            content: [
              "Workflow launched in background. Task ID: wwgczx5jh",
              "Summary: Verify quickjs-ng assets/digests, yt-dlp runtime discovery",
              `Transcript dir: /home/u/.claude/projects/p/1591ce94/subagents/workflows/${WORKFLOW_RUN_ID}`,
              `Script file: /home/u/.claude/projects/p/1591ce94/workflows/scripts/scout-${WORKFLOW_RUN_ID}.js`,
              `Run ID: ${WORKFLOW_RUN_ID}`,
              "You will be notified when it completes. Use /workflows to watch live progress.",
            ].join("\n"),
          },
        ],
      },
    },
  ];
}

/**
 * One Workflow child's transcript as the runner projects it: a prompt, a tool
 * call, its result, and the metadata the runner reads from the agent's
 * `.meta.json` (`description` + `workflowPhase`) because the launch text names
 * the run, never the agents inside it.
 */
function workflowAgentTranscript(
  agentId: string,
  description: string,
  phase: string,
  toolUseId: string,
): SessionMessage[] {
  // `workflowToolUseId` is the runner's statement that this agent runs under a
  // Workflow call rather than an `Agent` call — the browser cannot infer it
  // when the call itself falls outside the page of messages it asked for.
  const meta = {
    agentLabel: description,
    agentType: "workflow-subagent",
    workflowPhase: phase,
    parentToolUseId: WORKFLOW_TOOL_USE_ID,
    workflowToolUseId: WORKFLOW_TOOL_USE_ID,
  };
  return [
    {
      type: "user",
      uuid: `${agentId}-prompt`,
      agentId,
      ...meta,
      message: { role: "user", content: `Investigate ${description}` },
    },
    {
      type: "assistant",
      uuid: `${agentId}-step`,
      agentId,
      ...meta,
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: toolUseId, name: "Read", input: { file_path: "apps/x.ts" } },
        ],
      },
    },
    {
      type: "user",
      uuid: `${agentId}-result`,
      agentId,
      ...meta,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: "12 lines" }],
      },
    },
  ];
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

  test("splits a Workflow's agents into their own items and labels them from the transcript metadata", () => {
    resetSeq();
    // The real shape the runner sees (verified against a live transcript): the
    // Workflow tool_result is plain launch text, not JSON. There is no
    // `workflowProgress` array anywhere in the SDK — the only place an agent's
    // human label lives is its `.meta.json` (`description` + `workflowPhase`),
    // which the runner projects onto that agent's messages.
    const history: SessionMessage[] = [
      ...workflowLaunchMessages(),
      ...workflowAgentTranscript("a51c84ff15e3201f4", "plan-critique", "Scout", "toolu-wf-read-1"),
      ...workflowAgentTranscript("a7678005adbe47337", "quickjs-assets", "Scout", "toolu-wf-read-2"),
    ];

    const items = deriveSubagentItems(history, [], EMPTY_TASK_STATE);

    // Two agents under one Workflow call are two subagents — not one merged row.
    expect(items.map((i) => i.taskId)).toEqual(["a51c84ff15e3201f4", "a7678005adbe47337"]);
    expect(items.map((i) => i.description)).toEqual(["plan-critique", "quickjs-assets"]);
    // The phase is what the SDK calls the agent's workflow phase.
    expect(items.map((i) => i.workflowName)).toEqual(["Scout", "Scout"]);
    expect(items.map((i) => i.subagentType)).toEqual(["workflow-subagent", "workflow-subagent"]);
    for (const item of items) {
      // Each agent keeps its own tool history — this is the "0 events" symptom.
      expect(item.events.filter((e) => e.kind === "tool")).toHaveLength(1);
      expect(item.turns.map((t) => t.kind)).toEqual(["user", "agent"]);
    }
  });

  test("splits a Workflow's children even when the Workflow call is outside the page", () => {
    resetSeq();
    // A long session puts its `Workflow` calls far behind the tail page the
    // browser asked for, so the launch text is not in `historicalMessages` at
    // all. `workflowToolUseId` is what the runner knows and the browser cannot
    // infer: without it these three children share one `parentToolUseId`, get
    // keyed on it, and collapse back into a single renaming row — the original
    // "5 spawned, 1 shown" symptom, arriving by a different road.
    const history: SessionMessage[] = [
      ...workflowAgentTranscript("a51c84ff15e3201f4", "plan-critique", "Scout", "toolu-wf-read-1"),
      ...workflowAgentTranscript("a7678005adbe47337", "quickjs-assets", "Scout", "toolu-wf-read-2"),
      ...workflowAgentTranscript("a648ed22b0223633f", "test-inventory", "Scout", "toolu-wf-read-3"),
    ];

    const items = deriveSubagentItems(history, [], EMPTY_TASK_STATE);

    expect(items).toHaveLength(3);
    expect(items.map((i) => i.description)).toEqual([
      "plan-critique",
      "quickjs-assets",
      "test-inventory",
    ]);
    // Each child reports the call it runs under, never as its own identity.
    for (const item of items) {
      expect(item.workflowToolUseId).toBe(WORKFLOW_TOOL_USE_ID);
      expect(item.toolUseId).toBeUndefined();
      expect(item.events.filter((e) => e.kind === "tool")).toHaveLength(1);
    }
  });

  test("inspecting the Workflow call selects one of its children", () => {
    resetSeq();
    // The main-screen `Workflow` step is the entry point into the inspector, and
    // it only knows the call's tool-use id. The run's own row is gone, so that
    // id has to resolve through a child — falling back to "the first item" would
    // open the wrong subagent.
    const history: SessionMessage[] = [
      ...workflowAgentTranscript("a51c84ff15e3201f4", "plan-critique", "Scout", "toolu-wf-read-1"),
      ...workflowAgentTranscript("a7678005adbe47337", "quickjs-assets", "Scout", "toolu-wf-read-2"),
    ];
    const items = deriveSubagentItems(history, [], EMPTY_TASK_STATE);

    const selected = resolveSelectedSubagentId(items, WORKFLOW_TOOL_USE_ID);

    expect(items.find((i) => i.id === selected)?.workflowToolUseId).toBe(WORKFLOW_TOOL_USE_ID);
  });

  test("keeps a Workflow's container row only while it has no readable children", () => {
    resetSeq();
    // The SDK reports the run itself as a `local_workflow` background task whose
    // `description` cycles through each agent's label ("Scout: plan-critique" →
    // "Scout: ytdlp-discovery"). A child agent is the real subagent, so the row
    // is a stand-in: it must disappear as soon as one child is known, and must
    // survive when the children's transcripts are not readable yet — otherwise
    // a live workflow with nothing to split shows no subagent at all.
    const events: BrowserReplayEvent[] = [
      liveEvent("task.started", {
        taskId: "wwgczx5jh",
        runId: "run-wf",
        description: "Verify quickjs-ng assets",
        taskType: "local_workflow",
        workflowName: "ytdlp-js-runtime-scout",
        toolUseId: WORKFLOW_TOOL_USE_ID,
      }),
      liveEvent("task.progress", {
        taskId: "wwgczx5jh",
        runId: "run-wf",
        description: "Scout: plan-critique",
        lastToolName: "plan-critique",
      }),
    ];

    const alone = deriveSubagentItems([], events, taskStateFromEvents(events));
    expect(alone.map((i) => i.taskId)).toEqual(["wwgczx5jh"]);

    const withChildren = deriveSubagentItems(
      [
        ...workflowLaunchMessages(),
        ...workflowAgentTranscript(
          "a51c84ff15e3201f4",
          "plan-critique",
          "Scout",
          "toolu-wf-read-1",
        ),
      ],
      events,
      taskStateFromEvents(events),
    );

    // Only the child remains — the run's own row is gone, not renamed.
    expect(withChildren.map((i) => i.taskId)).toEqual(["a51c84ff15e3201f4"]);
  });

  test("keeps an Agent subagent whose transcript the runner could not label", () => {
    resetSeq();
    // A missing/unreadable `.meta.json` must degrade to today's behaviour (the
    // agent id as the label) rather than dropping the subagent: the transcript
    // is still there and its tool history is the point.
    const history: SessionMessage[] = [
      {
        type: "assistant",
        uuid: "unlabelled-step",
        agentId: "a51c84ff15e3201f4",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu-x", name: "Read", input: { file_path: "a.ts" } },
          ],
        },
      },
    ];

    const items = deriveSubagentItems(history, [], EMPTY_TASK_STATE);

    expect(items).toHaveLength(1);
    expect(items[0]?.description).toBe("a51c84ff15e3201f4");
    expect(items[0]?.events.filter((e) => e.kind === "tool")).toHaveLength(1);
  });

  test("correlates Agent subagents by agentId in live frames and historical tool_result + transcripts", () => {
    resetSeq();
    const history: SessionMessage[] = [
      {
        type: "assistant",
        uuid: "main-agent-call",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu-agent-1",
              name: "Agent",
              input: { description: "Audit scroll area", subagent_type: "Explore" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "main-agent-res",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-agent-1",
              content: "Async agent launched.\nagentId: ae3454d16c5171399",
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "sub-prompt",
        agentId: "ae3454d16c5171399",
        message: { role: "user", content: "Check ScrollArea.vue" },
      },
      {
        type: "assistant",
        uuid: "sub-step",
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
        uuid: "sub-tool-res",
        agentId: "ae3454d16c5171399",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu-wf-read-1", content: "29 lines" }],
        },
      },
    ];

    const items = deriveSubagentItems(history, [], EMPTY_TASK_STATE);
    expect(items).toHaveLength(1);
    const sub = items[0]!;
    expect(sub.taskId).toBe("ae3454d16c5171399");
    expect(sub.toolUseId).toBe("toolu-agent-1");
    // No `.meta.json` label on these messages: the spawning input supplies it.
    expect(sub.description).toBe("Audit scroll area");
    expect(sub.subagentType).toBe("Explore");
    expect(sub.events.filter((e) => e.kind === "tool")).toHaveLength(1);
    expect(sub.turns.map((t) => t.kind)).toEqual(["user", "agent"]);

    // A replayed live frame the legacy journal wrote without agentId still
    // resolves the subagent's tool step by its globally unique toolCallId.
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

describe("5-minute default visibility window and subagent history", () => {
  const mkItem = (partial: Partial<SubagentItem> & { id: string }): SubagentItem => ({
    description: partial.id,
    status: "running",
    events: [],
    turns: [],
    ...partial,
  });

  test("marks subagents settled and stamps completedAt across task.completed, tasks.changed, and tool.completed", () => {
    resetSeq();
    const events: BrowserReplayEvent[] = [
      // 1. Settled via task.completed
      liveEvent(
        "task.started",
        { taskId: "sub-task-done", runId: "run-1", description: "Via task.completed" },
        "run-1",
        "2026-11-05T10:00:00.000Z",
      ),
      liveEvent(
        "task.completed",
        { taskId: "sub-task-done", runId: "run-1", status: "completed" },
        "run-1",
        "2026-11-05T10:00:05.000Z",
      ),
      // 2. Settled via tasks.changed level reset (missed task.completed)
      liveEvent(
        "task.started",
        { taskId: "sub-level-reset", runId: "run-1", description: "Via tasks.changed" },
        "run-1",
        "2026-11-05T10:00:10.000Z",
      ),
      liveEvent("tasks.changed", { tasks: [] }, "run-1", "2026-11-05T10:00:15.000Z"),
      // 3. Settled via spawning Agent tool.completed without task record
      liveEvent(
        "tool.started",
        {
          toolCallId: "toolu-fg-1",
          toolName: "Agent",
          input: { description: "Via tool.completed" },
        },
        "run-1",
        "2026-11-05T10:00:20.000Z",
      ),
      liveEvent(
        "tool.completed",
        {
          toolCallId: "toolu-fg-1",
          isError: false,
          outputSummary: "Done foreground task",
        },
        "run-1",
        "2026-11-05T10:00:25.000Z",
      ),
    ];

    const items = deriveSubagentItems([], events, taskStateFromEvents(events));
    expect(items.map((i) => ({ id: i.id, status: i.status, completedAt: i.completedAt }))).toEqual([
      {
        id: "sub-task-done",
        status: "completed",
        completedAt: "2026-11-05T10:00:05.000Z",
      },
      {
        id: "sub-level-reset",
        status: "completed",
        completedAt: "2026-11-05T10:00:15.000Z",
      },
      {
        id: "toolu-fg-1",
        status: "completed",
        completedAt: "2026-11-05T10:00:25.000Z",
      },
    ]);
  });

  test("keeps running subagents visible and hides completed subagents 5 minutes after completion", () => {
    expect(SUBAGENT_DEFAULT_VISIBILITY_MS).toBe(5 * 60 * 1000);

    const completedIso = "2026-11-05T10:00:00.000Z";
    const completedMs = Date.parse(completedIso);

    const runningOld = mkItem({
      id: "running-30m",
      status: "running",
      startedAt: "2026-11-05T09:30:00.000Z",
      updatedAt: "2026-11-05T09:30:00.000Z",
    });
    const completedItem = mkItem({
      id: "done-1",
      status: "completed",
      completedAt: completedIso,
      updatedAt: completedIso,
    });
    const historicalNoTimestamp = mkItem({
      id: "hist-disk",
      status: "completed",
    });

    // Running subagent stays visible even after 30 minutes
    expect(isSubagentVisibleByDefault(runningOld, completedMs + 30 * 60 * 1000)).toBe(true);

    // Completed subagent stays visible right up to 4m 59.999s
    expect(isSubagentVisibleByDefault(completedItem, completedMs)).toBe(true);
    expect(
      isSubagentVisibleByDefault(completedItem, completedMs + SUBAGENT_DEFAULT_VISIBILITY_MS - 1),
    ).toBe(true);

    // At exactly 5 minutes (and beyond), completed subagent is hidden from default view
    expect(
      isSubagentVisibleByDefault(completedItem, completedMs + SUBAGENT_DEFAULT_VISIBILITY_MS),
    ).toBe(false);
    expect(isSubagentVisibleByDefault(completedItem, completedMs + 10 * 60 * 1000)).toBe(false);

    // Imported historical subagents without live completion timestamps are hidden by default
    expect(isSubagentVisibleByDefault(historicalNoTimestamp, completedMs)).toBe(false);
  });

  test("records all settled subagents in history while filtering default view by the 5-minute window", () => {
    const baseMs = Date.parse("2026-11-05T10:10:00.000Z");
    const items: SubagentItem[] = [
      mkItem({
        id: "still-running",
        status: "running",
        startedAt: "2026-11-05T10:00:00.000Z",
      }),
      mkItem({
        id: "done-2m-ago",
        status: "completed",
        completedAt: "2026-11-05T10:08:00.000Z",
      }),
      mkItem({
        id: "failed-6m-ago",
        status: "failed",
        completedAt: "2026-11-05T10:04:00.000Z",
      }),
      mkItem({
        id: "stopped-5m-ago",
        status: "stopped",
        completedAt: "2026-11-05T10:05:00.000Z",
      }),
      mkItem({
        id: "from-disk-history",
        status: "completed",
      }),
    ];

    expect(filterVisibleSubagents(items, baseMs).map((i) => i.id)).toEqual([
      "still-running",
      "done-2m-ago",
    ]);

    expect(filterHistorySubagents(items).map((i) => i.id)).toEqual([
      "done-2m-ago",
      "failed-6m-ago",
      "stopped-5m-ago",
      "from-disk-history",
    ]);
  });

  test("switches dialog tab to history when inspecting an older completed subagent", () => {
    const nowMs = Date.parse("2026-11-05T10:10:00.000Z");
    const items: SubagentItem[] = [
      mkItem({
        id: "recent-sub",
        toolUseId: "toolu-recent",
        status: "completed",
        completedAt: "2026-11-05T10:08:00.000Z",
      }),
      mkItem({
        id: "archived-sub",
        toolUseId: "toolu-archived",
        status: "completed",
        completedAt: "2026-11-05T10:00:00.000Z",
      }),
    ];

    expect(resolveSubagentDialogTab(items, "active", null, nowMs)).toBe("active");
    expect(resolveSubagentDialogTab(items, "history", null, nowMs)).toBe("history");
    expect(resolveSubagentDialogTab(items, "active", "toolu-recent", nowMs)).toBe("active");
    expect(resolveSubagentDialogTab(items, "active", "toolu-archived", nowMs)).toBe("history");
  });
});
