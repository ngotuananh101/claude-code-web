/**
 * Pure derivation of subagent items and their isolated event streams.
 *
 * Combines three sources into a deterministic list of `SubagentItem`s:
 * 1. `BackgroundTaskState` (`task.started` / `task.progress` / `task.completed` / `tasks.changed`)
 * 2. Live subagent frames in `BrowserReplayEvent[]` carrying `parentToolUseId` / `parent_tool_use_id`
 *    or `agentId` / `agent_id`
 * 3. Historical `SessionMessage[]` carrying `parentToolUseId` or `agentId` + main-stream
 *    `Agent`/`Task`/`Workflow` tool calls and results
 *
 * Keeping this pure lets both the Composer's subagent counter bar and the
 * 2-column Subagent Dialog render identically during live streaming and after reload.
 */
import type { BrowserReplayEvent, SessionMessage, TaskUsage } from "@cc-web/protocol";
import type { BackgroundTaskState } from "./background-tasks.ts";
import {
  type AgentStep,
  type AgentTurn,
  type ChatTurn,
  cleanUserPrompt,
  eventAgentId,
  eventParentToolUseId,
  extractDiffStats,
  extractToolField,
  formatDuration,
  isFileTool,
  summarizeToolInput,
  type ThinkingStep,
  type ToolStep,
} from "./chat-turns.ts";

export type SubagentStatus = "running" | "completed" | "failed" | "stopped";

export type SubagentEventItem =
  | {
      kind: "tool";
      key: string;
      step: ToolStep;
    }
  | {
      kind: "thinking";
      key: string;
      text: string;
    }
  | {
      kind: "text";
      key: string;
      text: string;
    };

export type SubagentItem = {
  /** Stable identifier: `taskId` when known, otherwise `toolUseId`. */
  id: string;
  taskId?: string;
  toolUseId?: string;
  description: string;
  subagentType?: string;
  workflowName?: string;
  parentTaskId?: string;
  status: SubagentStatus;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  usage?: TaskUsage;
  summary?: string;
  prompt?: string;
  events: SubagentEventItem[];
  /** Rich chat turns (`UserTurn` + `AgentTurn`) rendered with main-screen chat components. */
  turns: ChatTurn[];
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function isSubagentToolName(name: string): boolean {
  return name === "Agent" || name === "Task";
}

function isHousekeepingAgentId(id: string): boolean {
  return (
    id.startsWith("acompact-") ||
    id.startsWith("aprompt_suggestion-") ||
    id.startsWith("aside_question-")
  );
}

function textFromBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (rec?.["type"] === "text") {
      const text = asString(rec["text"]);
      if (text !== undefined) parts.push(text);
    }
  }
  return parts.join("\n\n");
}

function extractResultSummary(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const rec = asRecord(block);
      if (rec?.["type"] === "text" && typeof rec["text"] === "string") {
        parts.push(rec["text"]);
      }
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

function extractAgentIdFromText(text: string): string | undefined {
  const match = /\bagentId:\s*([A-Za-z0-9_-]+)/.exec(text);
  return match?.[1];
}

type WorkflowAgentProgressEntry = {
  agentId: string;
  label?: string;
  phaseTitle?: string;
  state?: string;
  startedAt?: number;
  lastProgressAt?: number;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
};

function extractWorkflowAgentsFromText(text: string): WorkflowAgentProgressEntry[] {
  if (!text.includes("workflowProgress")) return [];
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const progress = parsed?.["workflowProgress"];
    if (!Array.isArray(progress)) return [];
    const entries: WorkflowAgentProgressEntry[] = [];
    for (const raw of progress) {
      const rec = asRecord(raw);
      if (rec?.["type"] !== "workflow_agent") continue;
      const agentId = asString(rec["agentId"]);
      if (agentId === undefined) continue;
      const label = asString(rec["label"]);
      const phaseTitle = asString(rec["phaseTitle"]);
      const state = asString(rec["state"]);
      entries.push({
        agentId,
        ...(label !== undefined ? { label } : {}),
        ...(phaseTitle !== undefined ? { phaseTitle } : {}),
        ...(state !== undefined ? { state } : {}),
        ...(typeof rec["startedAt"] === "number" ? { startedAt: rec["startedAt"] } : {}),
        ...(typeof rec["lastProgressAt"] === "number"
          ? { lastProgressAt: rec["lastProgressAt"] }
          : {}),
        ...(typeof rec["tokens"] === "number" ? { tokens: rec["tokens"] } : {}),
        ...(typeof rec["toolCalls"] === "number" ? { toolCalls: rec["toolCalls"] } : {}),
        ...(typeof rec["durationMs"] === "number" ? { durationMs: rec["durationMs"] } : {}),
      });
    }
    return entries;
  } catch {
    return [];
  }
}

type ToolResultEntry = {
  toolUseId: string;
  content: unknown;
  isError: boolean;
};

function extractToolResults(message: Record<string, unknown> | null): ToolResultEntry[] {
  if (message === null) return [];
  if (message["type"] === "tool_result" && typeof message["tool_use_id"] === "string") {
    return [
      {
        toolUseId: message["tool_use_id"],
        content: message["content"],
        isError: message["is_error"] === true,
      },
    ];
  }
  const content = message["content"];
  if (!Array.isArray(content)) return [];
  const out: ToolResultEntry[] = [];
  for (const item of content) {
    const rec = asRecord(item);
    if (rec?.["type"] === "tool_result" && typeof rec["tool_use_id"] === "string") {
      out.push({
        toolUseId: rec["tool_use_id"],
        content: rec["content"],
        isError: rec["is_error"] === true,
      });
    }
  }
  return out;
}

function buildToolStep(
  keyPrefix: string,
  index: number,
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown> | undefined,
): ToolStep {
  const step: ToolStep = {
    kind: "tool",
    key: `${keyPrefix}-tool-${index}`,
    toolCallId,
    toolName,
    state: "running",
    inputSummary: summarizeToolInput(toolName, [input ?? {}]),
    outputSummary: null,
    rawPayload: input,
  };
  const field = extractToolField(toolName, input);
  if (field !== undefined) {
    if (toolName === "Bash") step.command = field;
    else if (isFileTool(toolName)) step.filePath = field;
  }
  const diffStats = extractDiffStats(toolName, input);
  if (diffStats !== null) step.diffStats = diffStats;
  return step;
}

function applyResolvedInput(step: ToolStep, input: Record<string, unknown>): void {
  step.rawPayload = input;
  step.inputSummary = summarizeToolInput(step.toolName, [input]);
  const field = extractToolField(step.toolName, input);
  if (field !== undefined) {
    if (step.toolName === "Bash") step.command = field;
    else if (isFileTool(step.toolName)) step.filePath = field;
  }
  const diffStats = extractDiffStats(step.toolName, input);
  if (diffStats !== null) step.diffStats = diffStats;
}

type MutableSubagent = {
  id: string;
  taskId?: string;
  toolUseId?: string;
  hasTaskRecord: boolean;
  description: string;
  subagentType?: string;
  workflowName?: string;
  parentTaskId?: string;
  status: SubagentStatus;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  usage?: TaskUsage;
  summary?: string;
  prompt?: string;
  events: SubagentEventItem[];
  turns: ChatTurn[];
  currentAgentTurn: AgentTurn | null;
  toolsByCallId: Map<string, ToolStep>;
  toolInputs: Map<string, Record<string, unknown>>;
  deltaTextByMsgId: Map<string, { index: number; text: string }>;
  seenMessageIds: Set<string>;
};

function createEmptyAccumulator(id: string): MutableSubagent {
  return {
    id,
    hasTaskRecord: false,
    description: "",
    status: "running",
    events: [],
    turns: [],
    currentAgentTurn: null,
    toolsByCallId: new Map(),
    toolInputs: new Map(),
    deltaTextByMsgId: new Map(),
    seenMessageIds: new Set(),
  };
}

function ensureSubagentTurn(acc: MutableSubagent): AgentTurn {
  if (acc.currentAgentTurn !== null) return acc.currentAgentTurn;
  const turn: AgentTurn = {
    kind: "agent",
    key: `${acc.id}-agent-${acc.turns.length}`,
    status: "running",
    steps: [],
    text: "",
    segments: [],
    isStreaming: true,
  };
  acc.currentAgentTurn = turn;
  acc.turns.push(turn);
  return turn;
}

function appendSubagentStep(acc: MutableSubagent, step: AgentStep): void {
  const turn = ensureSubagentTurn(acc);
  turn.steps.push(step);
  const last = turn.segments[turn.segments.length - 1];
  if (last !== undefined && last.kind === "process") {
    last.steps.push(step);
  } else {
    turn.segments.push({
      kind: "process",
      key: `${turn.key}-process-${turn.segments.length}`,
      steps: [step],
    });
  }
}

function appendSubagentProse(acc: MutableSubagent, text: string): void {
  if (text.trim() === "") return;
  const turn = ensureSubagentTurn(acc);
  turn.text = turn.text === "" ? text : `${turn.text}\n\n${text}`;
  const last = turn.segments[turn.segments.length - 1];
  if (last !== undefined && last.kind === "text") {
    last.text = last.text === "" ? text : `${last.text}\n\n${text}`;
  } else {
    turn.segments.push({
      kind: "text",
      key: `${turn.key}-text-${turn.segments.length}`,
      text,
    });
  }
}

function appendSubagentDelta(acc: MutableSubagent, text: string): void {
  if (text === "") return;
  const turn = ensureSubagentTurn(acc);
  const last = turn.segments[turn.segments.length - 1];
  if (last !== undefined && last.kind === "text") {
    last.text += text;
    turn.text += text;
  } else if (text.trim() !== "") {
    turn.segments.push({
      kind: "text",
      key: `${turn.key}-text-${turn.segments.length}`,
      text,
    });
    turn.text += text;
  }
}

function appendSubagentUserPrompt(acc: MutableSubagent, rawText: string, keySuffix: string): void {
  const cleaned = cleanUserPrompt(rawText);
  if (cleaned === "") return;
  if (acc.prompt === undefined) acc.prompt = cleaned;
  acc.currentAgentTurn = null;
  acc.turns.push({
    kind: "user",
    key: `${acc.id}-user-${keySuffix}`,
    text: cleaned,
  });
}

function resolveTurnStatus(status: SubagentStatus): AgentTurn["status"] {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "error";
    case "stopped":
      return "interrupted";
  }
}

function computeSubagentDurationText(acc: MutableSubagent): string | undefined {
  if (acc.usage?.durationMs !== undefined && acc.usage.durationMs > 0) {
    return formatDuration(acc.usage.durationMs);
  }
  if (acc.status !== "running" && acc.startedAt !== undefined && acc.updatedAt !== undefined) {
    const startMs = Date.parse(acc.startedAt);
    const endMs = Date.parse(acc.updatedAt);
    if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs >= startMs) {
      return formatDuration(endMs - startMs);
    }
  }
  return undefined;
}

function finalizeSubagentTurns(acc: MutableSubagent): ChatTurn[] {
  const turns = [...acc.turns];

  // If the spawning Agent/Task call supplied a prompt and no historical user bubble exists yet,
  // prepend the prompt as a UserTurn so the subagent view starts with the prompt bubble like the main chat.
  const hasUserTurn = turns.some((t) => t.kind === "user");
  if (!hasUserTurn && acc.prompt !== undefined && acc.prompt.trim() !== "") {
    const cleaned = cleanUserPrompt(acc.prompt);
    if (cleaned !== "") {
      turns.unshift({
        kind: "user",
        key: `${acc.id}-prompt`,
        text: cleaned,
      });
    }
  }

  let lastAgentTurn: AgentTurn | undefined;
  for (const t of turns) {
    if (t.kind === "agent") lastAgentTurn = t;
  }

  // If no agent turn exists yet (e.g. a newly started live subagent or a summary-only subagent),
  // synthesize one so AgentLiveStatus or Markdown summary renders seamlessly.
  const trimmedSummary = acc.summary?.trim() ?? "";
  if (lastAgentTurn === undefined) {
    if (acc.status === "running" || trimmedSummary !== "") {
      lastAgentTurn = {
        kind: "agent",
        key: `${acc.id}-agent-synth`,
        status: resolveTurnStatus(acc.status),
        steps: [],
        text: trimmedSummary,
        segments:
          trimmedSummary !== ""
            ? [{ kind: "text", key: `${acc.id}-agent-synth-text`, text: trimmedSummary }]
            : [],
        isStreaming: acc.status === "running",
      };
      turns.push(lastAgentTurn);
    }
  } else if (lastAgentTurn.text.trim() === "" && trimmedSummary !== "") {
    lastAgentTurn.text = trimmedSummary;
    lastAgentTurn.segments.push({
      kind: "text",
      key: `${lastAgentTurn.key}-summary-text`,
      text: trimmedSummary,
    });
  }

  const finalStatus = resolveTurnStatus(acc.status);
  const durationText = computeSubagentDurationText(acc);

  for (const t of turns) {
    if (t.kind !== "agent") continue;
    const isLast = t === lastAgentTurn;
    t.status = isLast ? finalStatus : "done";
    t.isStreaming = isLast && acc.status === "running";
    if (isLast) {
      if (acc.startedAt !== undefined) t.startedAt = acc.startedAt;
      if (durationText !== undefined) t.durationText = durationText;
    }
    if (t.status !== "running") {
      const settledToolState = t.status === "done" ? "done" : "interrupted";
      for (const step of t.steps) {
        if (step.kind === "tool" && step.state === "running") {
          step.state = settledToolState;
        }
      }
    }
  }

  return turns;
}

export function deriveSubagentItems(
  historicalMessages: readonly SessionMessage[],
  liveEvents: readonly BrowserReplayEvent[],
  taskState: BackgroundTaskState,
): SubagentItem[] {
  const ordered: MutableSubagent[] = [];
  const byTaskId = new Map<string, MutableSubagent>();
  const byToolUseId = new Map<string, MutableSubagent>();
  const subagentToolsByCallId = new Map<string, { acc: MutableSubagent; step: ToolStep }>();
  const ignoredTaskIds = new Set<string>();
  const ignoredToolUseIds = new Set<string>();
  const workflowToolUseIds = new Set<string>();

  // 1. Seed from BackgroundTaskState (authoritative for live status, usage, elapsed).
  for (const task of taskState.tasks.values()) {
    if (task.ambient || task.skipTranscript === true || isHousekeepingAgentId(task.taskId)) {
      ignoredTaskIds.add(task.taskId);
      if (task.toolUseId !== undefined) ignoredToolUseIds.add(task.toolUseId);
      continue;
    }
    const acc = createEmptyAccumulator(task.taskId);
    acc.taskId = task.taskId;
    acc.hasTaskRecord = true;
    acc.description = task.description;
    if (task.toolUseId !== undefined) acc.toolUseId = task.toolUseId;
    if (task.subagentType !== undefined) acc.subagentType = task.subagentType;
    if (task.workflowName !== undefined) acc.workflowName = task.workflowName;
    if (task.parentTaskId !== undefined) acc.parentTaskId = task.parentTaskId;
    acc.status =
      task.status === "running" && !taskState.liveTaskIds.has(task.taskId)
        ? "completed"
        : task.status;
    acc.startedAt = task.startedAt;
    acc.updatedAt = task.updatedAt;
    if (task.status !== "running") {
      acc.completedAt = task.updatedAt;
    }
    if (task.usage !== undefined) acc.usage = task.usage;
    if (task.summary !== undefined) acc.summary = task.summary;

    ordered.push(acc);
    byTaskId.set(task.taskId, acc);
    if (task.toolUseId !== undefined) byToolUseId.set(task.toolUseId, acc);
  }

  function ensureByTaskId(taskId: string): MutableSubagent | undefined {
    if (ignoredTaskIds.has(taskId) || isHousekeepingAgentId(taskId)) return undefined;
    let acc = byTaskId.get(taskId);
    if (acc === undefined) {
      acc = createEmptyAccumulator(taskId);
      acc.taskId = taskId;
      ordered.push(acc);
      byTaskId.set(taskId, acc);
    }
    return acc;
  }

  function ensureByToolUseId(toolUseId: string): MutableSubagent | undefined {
    if (ignoredToolUseIds.has(toolUseId) || workflowToolUseIds.has(toolUseId)) return undefined;
    let acc = byToolUseId.get(toolUseId);
    if (acc === undefined) {
      acc = createEmptyAccumulator(toolUseId);
      acc.toolUseId = toolUseId;
      ordered.push(acc);
      byToolUseId.set(toolUseId, acc);
    }
    return acc;
  }

  function linkTaskAndToolUse(taskId: string, toolUseId: string): MutableSubagent | undefined {
    if (ignoredTaskIds.has(taskId) || isHousekeepingAgentId(taskId)) return undefined;
    if (ignoredToolUseIds.has(toolUseId) || workflowToolUseIds.has(toolUseId)) return undefined;
    const byTask = byTaskId.get(taskId);
    const byTool = byToolUseId.get(toolUseId);
    if (byTask !== undefined && byTool !== undefined && byTask !== byTool) {
      // Merge metadata from byTool into byTask and remove the duplicate placeholder.
      byTask.toolUseId ??= toolUseId;
      if (byTask.description === "" && byTool.description !== "") {
        byTask.description = byTool.description;
      }
      if (byTask.subagentType === undefined && byTool.subagentType !== undefined) {
        byTask.subagentType = byTool.subagentType;
      }
      if (byTask.prompt === undefined && byTool.prompt !== undefined) {
        byTask.prompt = byTool.prompt;
      }
      if (byTask.summary === undefined && byTool.summary !== undefined) {
        byTask.summary = byTool.summary;
      }
      if (byTask.startedAt === undefined && byTool.startedAt !== undefined) {
        byTask.startedAt = byTool.startedAt;
      }
      if (byTask.updatedAt === undefined && byTool.updatedAt !== undefined) {
        byTask.updatedAt = byTool.updatedAt;
      }
      if (
        byTask.completedAt === undefined &&
        byTool.completedAt !== undefined &&
        byTask.status !== "running"
      ) {
        byTask.completedAt = byTool.completedAt;
      }
      if (byTask.events.length === 0 && byTool.events.length > 0) {
        byTask.events = byTool.events;
        byTask.turns = byTool.turns;
        byTask.currentAgentTurn = byTool.currentAgentTurn;
        byTask.toolsByCallId = byTool.toolsByCallId;
        byTask.toolInputs = byTool.toolInputs;
      }
      byToolUseId.set(toolUseId, byTask);
      const idx = ordered.indexOf(byTool);
      if (idx >= 0) ordered.splice(idx, 1);
      return byTask;
    }
    if (byTask !== undefined) {
      byTask.toolUseId ??= toolUseId;
      byToolUseId.set(toolUseId, byTask);
      return byTask;
    }
    if (byTool !== undefined) {
      byTool.taskId ??= taskId;
      byTaskId.set(taskId, byTool);
      return byTool;
    }
    const acc = createEmptyAccumulator(taskId);
    acc.taskId = taskId;
    acc.toolUseId = toolUseId;
    ordered.push(acc);
    byTaskId.set(taskId, acc);
    byToolUseId.set(toolUseId, acc);
    return acc;
  }

  function resolveSubagentAcc(
    agentId: string | undefined,
    parentId: string | undefined,
  ): MutableSubagent | undefined {
    if (agentId !== undefined && parentId !== undefined && !workflowToolUseIds.has(parentId)) {
      return linkTaskAndToolUse(agentId, parentId);
    }
    if (agentId !== undefined) {
      return ensureByTaskId(agentId);
    }
    if (parentId !== undefined) {
      return ensureByToolUseId(parentId);
    }
    return undefined;
  }

  function applySpawningInput(acc: MutableSubagent, input: Record<string, unknown> | null): void {
    if (input === null) return;
    const desc = asString(input["description"]);
    const subType = asString(input["subagent_type"]) ?? asString(input["subagentType"]);
    const prompt = asString(input["prompt"]);
    if (acc.description === "" && desc !== undefined) acc.description = desc;
    if (acc.subagentType === undefined && subType !== undefined) acc.subagentType = subType;
    if (acc.prompt === undefined && prompt !== undefined) acc.prompt = prompt;
  }

  function applyWorkflowAgentEntries(entries: readonly WorkflowAgentProgressEntry[]): void {
    for (const entry of entries) {
      const wfAcc = ensureByTaskId(entry.agentId);
      if (wfAcc === undefined) continue;
      if (wfAcc.description === "" && entry.label !== undefined) {
        wfAcc.description = entry.label;
      }
      if (wfAcc.workflowName === undefined && entry.phaseTitle !== undefined) {
        wfAcc.workflowName = entry.phaseTitle;
      }
      wfAcc.subagentType ??= "workflow-subagent";
      if (!wfAcc.hasTaskRecord && entry.state !== undefined) {
        wfAcc.status =
          entry.state === "done"
            ? "completed"
            : entry.state === "error" || entry.state === "failed"
              ? "failed"
              : entry.state === "stopped" || entry.state === "killed"
                ? "stopped"
                : "running";
      }
      if (wfAcc.startedAt === undefined && entry.startedAt !== undefined) {
        wfAcc.startedAt = new Date(entry.startedAt).toISOString();
      }
      if (wfAcc.updatedAt === undefined && entry.lastProgressAt !== undefined) {
        wfAcc.updatedAt = new Date(entry.lastProgressAt).toISOString();
      }
      if (
        wfAcc.usage === undefined &&
        entry.tokens !== undefined &&
        entry.toolCalls !== undefined &&
        entry.durationMs !== undefined
      ) {
        wfAcc.usage = {
          totalTokens: entry.tokens,
          toolUses: entry.toolCalls,
          durationMs: entry.durationMs,
        };
      }
    }
  }

  // Track which subagents have live content frames so we don't duplicate
  // historical replay on top of live events for the same subagent.
  const liveParentToolUseIds = new Set<string>();
  const liveAgentIds = new Set<string>();
  for (const event of liveEvents) {
    const payload = asRecord(event.payload) ?? {};
    const parentId = eventParentToolUseId(payload);
    const agentId = eventAgentId(payload);
    if (parentId !== undefined) liveParentToolUseIds.add(parentId);
    if (agentId !== undefined) liveAgentIds.add(agentId);
  }

  // 2a. First pass over main historicalMessages to discover spawning Agent/Task/Workflow calls
  // and link agentId <-> toolUseId before routing subagent historical messages.
  for (const message of historicalMessages) {
    if (message.type === "system") continue;
    const parentId = asString(message.parentToolUseId);
    const agentId = asString(message.agentId);
    if (parentId !== undefined || agentId !== undefined) continue;

    const msg = asRecord(message.message);
    if (message.type === "assistant") {
      const content = msg?.["content"];
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const rec = asRecord(block);
        if (rec?.["type"] !== "tool_use") continue;
        const id = asString(rec["id"]);
        const name = asString(rec["name"]);
        if (id === undefined || name === undefined) continue;
        if (name === "Workflow") {
          workflowToolUseIds.add(id);
          continue;
        }
        if (!isSubagentToolName(name)) continue;
        const acc = ensureByToolUseId(id);
        if (acc !== undefined) applySpawningInput(acc, asRecord(rec["input"]));
      }
    } else if (message.type === "user") {
      for (const res of extractToolResults(msg)) {
        const text = extractResultSummary(res.content);
        if (text !== null) {
          const wfEntries = extractWorkflowAgentsFromText(text);
          if (wfEntries.length > 0) {
            workflowToolUseIds.add(res.toolUseId);
            applyWorkflowAgentEntries(wfEntries);
            continue;
          }
        }
        let acc = byToolUseId.get(res.toolUseId);
        if (acc !== undefined && text !== null) {
          const linkedAgentId = extractAgentIdFromText(text);
          if (linkedAgentId !== undefined) {
            acc = linkTaskAndToolUse(linkedAgentId, res.toolUseId) ?? acc;
          }
        }
        if (acc === undefined) continue;
        if (!acc.hasTaskRecord) {
          acc.status = res.isError ? "failed" : "completed";
        }
        if (acc.summary === undefined && text !== null && text.trim() !== "") {
          acc.summary = text.trim();
        }
      }
    }
  }

  // 2b. Second pass over subagent historicalMessages.
  for (const message of historicalMessages) {
    if (message.type === "system") continue;
    const parentId = asString(message.parentToolUseId);
    const agentId = asString(message.agentId);
    if (parentId === undefined && agentId === undefined) continue;

    // Skip if live events already cover this subagent.
    if (agentId !== undefined && liveAgentIds.has(agentId)) continue;
    if (parentId !== undefined && liveParentToolUseIds.has(parentId)) continue;

    const acc = resolveSubagentAcc(agentId, parentId);
    if (acc === undefined) continue;

    const msg = asRecord(message.message);
    if (message.type === "assistant") {
      const content = msg?.["content"];
      if (typeof content === "string") {
        if (content.trim() !== "") {
          acc.events.push({
            kind: "text",
            key: `${acc.id}-hist-text-${acc.events.length}`,
            text: content,
          });
          appendSubagentProse(acc, content);
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const rec = asRecord(block);
          if (rec === null) continue;
          if (rec["type"] === "thinking") {
            const thinking = asString(rec["thinking"]);
            if (thinking !== undefined && thinking !== "") {
              const key = `${acc.id}-hist-thinking-${acc.events.length}`;
              acc.events.push({
                kind: "thinking",
                key,
                text: thinking,
              });
              const thinkingStep: ThinkingStep = {
                kind: "thinking",
                key,
                text: thinking,
              };
              appendSubagentStep(acc, thinkingStep);
            }
          } else if (rec["type"] === "tool_use") {
            const id = asString(rec["id"]);
            const name = asString(rec["name"]);
            if (id !== undefined && name !== undefined) {
              const input = asRecord(rec["input"]) ?? undefined;
              const step = buildToolStep(`${acc.id}-hist`, acc.events.length, id, name, input);
              acc.toolsByCallId.set(id, step);
              acc.events.push({ kind: "tool", key: step.key, step });
              appendSubagentStep(acc, step);
            }
          } else if (rec["type"] === "text") {
            const text = asString(rec["text"]);
            if (text !== undefined && text.trim() !== "") {
              acc.events.push({
                kind: "text",
                key: `${acc.id}-hist-text-${acc.events.length}`,
                text,
              });
              appendSubagentProse(acc, text);
            }
          }
        }
      }
    } else if (message.type === "user") {
      const toolResults = extractToolResults(msg);
      if (toolResults.length > 0) {
        for (const res of toolResults) {
          const step = acc.toolsByCallId.get(res.toolUseId);
          if (step !== undefined) {
            step.state = res.isError ? "error" : "done";
            step.outputSummary = extractResultSummary(res.content);
          }
        }
      } else {
        const promptText =
          typeof msg?.["content"] === "string" ? msg["content"] : textFromBlocks(msg?.["content"]);
        if (promptText.trim() !== "") {
          appendSubagentUserPrompt(acc, promptText, message.uuid);
        }
      }
    }

    if (!acc.hasTaskRecord && acc.status === "running") {
      acc.status = "completed";
    }
  }

  // 3. Scan liveEvents for spawning Agent/Task/Workflow inputs/completions and live subagent events.
  const seenLiveTasks = new Set<string>();
  for (const event of liveEvents) {
    const payload = asRecord(event.payload) ?? {};
    const parentId = eventParentToolUseId(payload);
    const agentId = eventAgentId(payload);

    if (parentId === undefined && agentId === undefined) {
      // Main stream: pick up spawning Agent/Task/Workflow metadata and tool completion fallback.
      if (event.type === "task.started") {
        const taskId = asString(payload["taskId"]);
        if (taskId !== undefined) seenLiveTasks.add(taskId);
        continue;
      }
      if (event.type === "task.completed") {
        const taskId = asString(payload["taskId"]);
        if (taskId !== undefined) {
          seenLiveTasks.delete(taskId);
          const acc = byTaskId.get(taskId);
          if (acc !== undefined && acc.status !== "running") {
            acc.completedAt = event.occurredAt;
            acc.updatedAt = event.occurredAt;
          }
        }
        continue;
      }
      if (event.type === "tasks.changed") {
        const rawTasks = payload["tasks"];
        if (Array.isArray(rawTasks)) {
          const nextLive = new Set<string>();
          for (const entry of rawTasks) {
            const id = asString(asRecord(entry)?.["taskId"]);
            if (id !== undefined) nextLive.add(id);
          }
          for (const prevId of seenLiveTasks) {
            if (!nextLive.has(prevId) && !taskState.liveTaskIds.has(prevId)) {
              const acc = byTaskId.get(prevId);
              if (acc !== undefined && acc.completedAt === undefined) {
                acc.completedAt = event.occurredAt;
                acc.updatedAt = event.occurredAt;
              }
            }
          }
          seenLiveTasks.clear();
          for (const id of nextLive) seenLiveTasks.add(id);
        }
        continue;
      }
      if (
        event.type === "run.finished" ||
        event.type === "run.failed" ||
        event.type === "run.interrupted"
      ) {
        const terminalStatus: SubagentStatus =
          event.type === "run.failed"
            ? "failed"
            : event.type === "run.interrupted"
              ? "stopped"
              : "completed";
        for (const acc of ordered) {
          if (!acc.hasTaskRecord && acc.status === "running") {
            acc.status = terminalStatus;
            acc.completedAt = event.occurredAt;
            acc.updatedAt = event.occurredAt;
          }
        }
        continue;
      }
      if (event.type === "message.completed") {
        const msg = asRecord(payload["message"]);
        const content = msg?.["content"];
        if (Array.isArray(content)) {
          for (const block of content) {
            const rec = asRecord(block);
            if (rec?.["type"] !== "tool_use") continue;
            const id = asString(rec["id"]);
            const name = asString(rec["name"]);
            if (id === undefined || name === undefined) continue;
            if (name === "Workflow") {
              workflowToolUseIds.add(id);
              continue;
            }
            if (!isSubagentToolName(name)) continue;
            const acc = ensureByToolUseId(id);
            if (acc !== undefined) {
              applySpawningInput(acc, asRecord(rec["input"]));
              acc.startedAt ??= event.occurredAt;
              acc.updatedAt = event.occurredAt;
            }
          }
        }
      } else if (event.type === "tool.started") {
        const toolCallId = asString(payload["toolCallId"]);
        const toolName = asString(payload["toolName"]);
        if (toolCallId !== undefined && toolName !== undefined) {
          if (toolName === "Workflow") {
            workflowToolUseIds.add(toolCallId);
          } else if (isSubagentToolName(toolName)) {
            const acc = ensureByToolUseId(toolCallId);
            if (acc !== undefined) {
              applySpawningInput(acc, asRecord(payload["input"]));
              acc.startedAt ??= event.occurredAt;
              acc.updatedAt = event.occurredAt;
            }
          }
        }
      } else if (event.type === "tool.completed") {
        const toolCallId = asString(payload["toolCallId"]);
        const outSummary = asString(payload["outputSummary"]);
        if (outSummary !== undefined) {
          const wfEntries = extractWorkflowAgentsFromText(outSummary);
          if (wfEntries.length > 0) {
            if (toolCallId !== undefined) workflowToolUseIds.add(toolCallId);
            applyWorkflowAgentEntries(wfEntries);
            for (const wfEntry of wfEntries) {
              const wfAcc = byTaskId.get(wfEntry.agentId);
              if (
                wfAcc !== undefined &&
                wfAcc.status !== "running" &&
                wfAcc.completedAt === undefined
              ) {
                wfAcc.completedAt = event.occurredAt;
                wfAcc.updatedAt = event.occurredAt;
              }
            }
            continue;
          }
        }
        if (toolCallId !== undefined) {
          const subTool = subagentToolsByCallId.get(toolCallId);
          if (subTool !== undefined) {
            subTool.step.state = payload["isError"] === true ? "error" : "done";
            subTool.step.outputSummary = outSummary ?? null;
            const completedInput =
              asRecord(payload["input"]) ?? subTool.acc.toolInputs.get(toolCallId);
            if (completedInput !== undefined) {
              applyResolvedInput(subTool.step, completedInput);
            }
            if (!subTool.acc.hasTaskRecord) {
              subTool.acc.updatedAt = event.occurredAt;
            }
            continue;
          }

          let acc = byToolUseId.get(toolCallId);
          if (acc !== undefined && outSummary !== undefined) {
            const linkedAgentId = extractAgentIdFromText(outSummary);
            if (linkedAgentId !== undefined) {
              acc = linkTaskAndToolUse(linkedAgentId, toolCallId) ?? acc;
            }
          }
          if (acc !== undefined) {
            if (
              !acc.hasTaskRecord ||
              (acc.taskId !== undefined && !taskState.liveTaskIds.has(acc.taskId))
            ) {
              if (!acc.hasTaskRecord || acc.status === "running") {
                acc.status = payload["isError"] === true ? "failed" : "completed";
              }
              if (acc.completedAt === undefined) {
                acc.completedAt = event.occurredAt;
                acc.updatedAt = event.occurredAt;
              }
            }
            if (acc.summary === undefined && outSummary !== undefined) {
              acc.summary = outSummary;
            }
          }
        }
      }
      continue;
    }

    // Live subagent event: route into the subagent accumulator by agentId / parentId.
    const acc = resolveSubagentAcc(agentId, parentId);
    if (acc === undefined) continue;
    acc.startedAt ??= event.occurredAt;
    if (!acc.hasTaskRecord) {
      acc.updatedAt = event.occurredAt;
    }

    if (event.type === "approval.requested") {
      appendSubagentStep(acc, {
        kind: "approval",
        key: `${acc.id}-approval-${event.eventId}`,
        event,
      });
      continue;
    }

    if (event.type === "message.delta") {
      const msgId = asString(payload["messageId"]) ?? "default";
      const text = asString(payload["text"]);
      if (text === undefined || text === "") continue;
      const existing = acc.deltaTextByMsgId.get(msgId);
      if (existing !== undefined) {
        existing.text += text;
        const item = acc.events[existing.index];
        if (item?.kind === "text") {
          item.text = existing.text;
        }
        appendSubagentDelta(acc, text);
      } else if (text.trim() !== "") {
        const index = acc.events.length;
        acc.deltaTextByMsgId.set(msgId, { index, text });
        acc.events.push({
          kind: "text",
          key: `${acc.id}-live-text-${msgId}-${index}`,
          text,
        });
        appendSubagentDelta(acc, text);
      }
      continue;
    }

    if (event.type === "message.completed") {
      const msg = asRecord(payload["message"]);
      if (msg === null) continue;
      const msgId = asString(msg["id"]);
      const firstSeen = msgId === undefined || !acc.seenMessageIds.has(msgId);
      if (msgId !== undefined) acc.seenMessageIds.add(msgId);
      const hasDeltaForMsg = msgId !== undefined && acc.deltaTextByMsgId.has(msgId);

      const content = msg["content"];
      if (typeof content === "string") {
        if (firstSeen && !hasDeltaForMsg && content.trim() !== "") {
          acc.events.push({
            kind: "text",
            key: `${acc.id}-live-text-complete-${acc.events.length}`,
            text: content,
          });
          appendSubagentProse(acc, content);
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const rec = asRecord(block);
          if (rec === null) continue;
          if (rec["type"] === "thinking" && firstSeen) {
            const thinking = asString(rec["thinking"]);
            if (thinking !== undefined && thinking !== "") {
              const key = `${acc.id}-live-thinking-${acc.events.length}`;
              acc.events.push({
                kind: "thinking",
                key,
                text: thinking,
              });
              appendSubagentStep(acc, {
                kind: "thinking",
                key,
                text: thinking,
              });
            }
          } else if (rec["type"] === "tool_use") {
            const id = asString(rec["id"]);
            const name = asString(rec["name"]);
            const inputRec = asRecord(rec["input"]);
            if (id !== undefined) {
              if (inputRec !== null) acc.toolInputs.set(id, inputRec);
              const existingStep = acc.toolsByCallId.get(id);
              if (existingStep !== undefined) {
                if (inputRec !== null) applyResolvedInput(existingStep, inputRec);
              } else if (name !== undefined) {
                // Subagents in Claude Code SDK emit complete assistant messages without
                // prior stream_event tool.started frames; create the ToolStep here.
                const step = buildToolStep(
                  `${acc.id}-live`,
                  acc.events.length,
                  id,
                  name,
                  inputRec ?? undefined,
                );
                acc.toolsByCallId.set(id, step);
                subagentToolsByCallId.set(id, { acc, step });
                acc.events.push({ kind: "tool", key: step.key, step });
                appendSubagentStep(acc, step);
              }
            }
          } else if (rec["type"] === "text" && firstSeen && !hasDeltaForMsg) {
            const text = asString(rec["text"]);
            if (text !== undefined && text.trim() !== "") {
              acc.events.push({
                kind: "text",
                key: `${acc.id}-live-text-complete-${acc.events.length}`,
                text,
              });
              appendSubagentProse(acc, text);
            }
          }
        }
      }
      continue;
    }

    if (event.type === "tool.started") {
      const toolCallId = asString(payload["toolCallId"]);
      const toolName = asString(payload["toolName"]);
      if (toolCallId === undefined || toolName === undefined) continue;
      const existingStep = acc.toolsByCallId.get(toolCallId);
      if (existingStep !== undefined) {
        const inputRec = asRecord(payload["input"]);
        if (inputRec !== null) applyResolvedInput(existingStep, inputRec);
        continue;
      }
      const resolvedInput =
        acc.toolInputs.get(toolCallId) ?? asRecord(payload["input"]) ?? undefined;
      const step = buildToolStep(
        `${acc.id}-live`,
        acc.events.length,
        toolCallId,
        toolName,
        resolvedInput,
      );
      acc.toolsByCallId.set(toolCallId, step);
      subagentToolsByCallId.set(toolCallId, { acc, step });
      acc.events.push({ kind: "tool", key: step.key, step });
      appendSubagentStep(acc, step);
      continue;
    }

    if (event.type === "tool.completed") {
      const toolCallId = asString(payload["toolCallId"]);
      if (toolCallId === undefined) continue;
      let step = acc.toolsByCallId.get(toolCallId);
      if (step === undefined) {
        const fallbackName = asString(payload["toolName"]) ?? "Tool";
        const fallbackInput =
          acc.toolInputs.get(toolCallId) ?? asRecord(payload["input"]) ?? undefined;
        step = buildToolStep(
          `${acc.id}-live`,
          acc.events.length,
          toolCallId,
          fallbackName,
          fallbackInput,
        );
        acc.toolsByCallId.set(toolCallId, step);
        acc.events.push({ kind: "tool", key: step.key, step });
        appendSubagentStep(acc, step);
      }
      step.state = payload["isError"] === true ? "error" : "done";
      step.outputSummary = asString(payload["outputSummary"]) ?? null;
      const completedInput = asRecord(payload["input"]) ?? acc.toolInputs.get(toolCallId);
      if (completedInput !== undefined) {
        applyResolvedInput(step, completedInput);
      }
    }
  }

  return ordered.map((acc): SubagentItem => {
    const description =
      acc.description ||
      acc.subagentType ||
      acc.workflowName ||
      acc.taskId ||
      acc.toolUseId ||
      acc.id;
    const turns = finalizeSubagentTurns(acc);
    return {
      id: acc.id,
      ...(acc.taskId === undefined ? {} : { taskId: acc.taskId }),
      ...(acc.toolUseId === undefined ? {} : { toolUseId: acc.toolUseId }),
      description,
      ...(acc.subagentType === undefined ? {} : { subagentType: acc.subagentType }),
      ...(acc.workflowName === undefined ? {} : { workflowName: acc.workflowName }),
      ...(acc.parentTaskId === undefined ? {} : { parentTaskId: acc.parentTaskId }),
      status: acc.status,
      ...(acc.startedAt === undefined ? {} : { startedAt: acc.startedAt }),
      ...(acc.updatedAt === undefined ? {} : { updatedAt: acc.updatedAt }),
      ...(acc.completedAt === undefined ? {} : { completedAt: acc.completedAt }),
      ...(acc.usage === undefined ? {} : { usage: acc.usage }),
      ...(acc.summary === undefined ? {} : { summary: acc.summary }),
      ...(acc.prompt === undefined ? {} : { prompt: acc.prompt }),
      events: acc.events,
      turns,
    };
  });
}

export type SubagentCounts = {
  total: number;
  running: number;
  completed: number;
  failed: number;
  stopped: number;
};

export function summarizeSubagentCounts(items: readonly SubagentItem[]): SubagentCounts {
  let running = 0;
  let completed = 0;
  let failed = 0;
  let stopped = 0;
  for (const item of items) {
    if (item.status === "running") running += 1;
    else if (item.status === "completed") completed += 1;
    else if (item.status === "failed") failed += 1;
    else if (item.status === "stopped") stopped += 1;
  }
  return {
    total: items.length,
    running,
    completed,
    failed,
    stopped,
  };
}

/**
 * Resolve which subagent item should be highlighted in the 2-column dialog.
 * Matches against `id`, `taskId`, or `toolUseId` so clicking either an `Agent`
 * tool step in the main chat or an item in the left rail selects the right entry.
 */
export function resolveSelectedSubagentId(
  items: readonly SubagentItem[],
  requestedId: string | null | undefined,
): string | null {
  if (items.length === 0) return null;
  if (requestedId !== undefined && requestedId !== null && requestedId !== "") {
    const found = items.find(
      (item) =>
        item.id === requestedId || item.taskId === requestedId || item.toolUseId === requestedId,
    );
    if (found !== undefined) return found.id;
  }
  const firstRunning = items.find((item) => item.status === "running");
  return firstRunning?.id ?? items[0]?.id ?? null;
}

/**
 * Default visibility window after a subagent completes before it hides from
 * the main Composer bar and the default Subagent dialog tab (5 minutes).
 */
export const SUBAGENT_DEFAULT_VISIBILITY_MS = 5 * 60 * 1000;

export type SubagentDialogTab = "active" | "history";

/**
 * Whether a subagent should appear in the default display:
 * - Running subagents stay visible indefinitely.
 * - Completed/failed/stopped subagents stay visible for 5 minutes after completion,
 *   then hide from the default display and remain accessible via History.
 */
export function isSubagentVisibleByDefault(
  item: SubagentItem,
  nowMs: number = Date.now(),
  ttlMs: number = SUBAGENT_DEFAULT_VISIBILITY_MS,
): boolean {
  if (item.status === "running") return true;
  const completedTimestamp = item.completedAt ?? item.updatedAt;
  if (completedTimestamp === undefined) return false;
  const completedMs = Date.parse(completedTimestamp);
  if (Number.isNaN(completedMs)) return false;
  return nowMs - completedMs < ttlMs;
}

/** Subagents currently shown in the default display (running + completed < 5m ago). */
export function filterVisibleSubagents(
  items: readonly SubagentItem[],
  nowMs: number = Date.now(),
  ttlMs: number = SUBAGENT_DEFAULT_VISIBILITY_MS,
): SubagentItem[] {
  return items.filter((item) => isSubagentVisibleByDefault(item, nowMs, ttlMs));
}

/** All settled subagents (`completed`, `failed`, `stopped`) recorded in History. */
export function filterHistorySubagents(items: readonly SubagentItem[]): SubagentItem[] {
  return items.filter((item) => item.status !== "running");
}

/**
 * Resolve which dialog tab (`active` vs `history`) should be active when opening
 * or selecting a subagent. Inspecting an archived subagent (completed >= 5m ago)
 * automatically switches to `history`.
 */
export function resolveSubagentDialogTab(
  items: readonly SubagentItem[],
  requestedTab: SubagentDialogTab,
  selectedId: string | null | undefined,
  nowMs: number = Date.now(),
  ttlMs: number = SUBAGENT_DEFAULT_VISIBILITY_MS,
): SubagentDialogTab {
  if (requestedTab === "history") return "history";
  if (selectedId !== undefined && selectedId !== null && selectedId !== "") {
    const matched = items.find(
      (item) =>
        item.id === selectedId || item.taskId === selectedId || item.toolUseId === selectedId,
    );
    if (matched !== undefined && !isSubagentVisibleByDefault(matched, nowMs, ttlMs)) {
      return "history";
    }
  }
  return "active";
}
