/**
 * Pure derivation of subagent items and their isolated event streams.
 *
 * Combines three sources into a deterministic list of `SubagentItem`s:
 * 1. `BackgroundTaskState` (`task.started` / `task.progress` / `task.completed` / `tasks.changed`)
 * 2. Live subagent frames in `BrowserReplayEvent[]` carrying `parentToolUseId` / `parent_tool_use_id`
 * 3. Historical `SessionMessage[]` carrying `parentToolUseId` + main-stream `Agent`/`Task` tool calls
 *
 * Keeping this pure lets both the Composer's subagent counter bar and the
 * 2-column Subagent Dialog render identically during live streaming and after reload.
 */
import type { BrowserReplayEvent, SessionMessage, TaskUsage } from "@cc-web/protocol";
import type { BackgroundTaskState } from "./background-tasks.ts";
import {
  eventParentToolUseId,
  extractDiffStats,
  extractToolField,
  isFileTool,
  summarizeToolInput,
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
  usage?: TaskUsage;
  summary?: string;
  prompt?: string;
  events: SubagentEventItem[];
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
  usage?: TaskUsage;
  summary?: string;
  prompt?: string;
  events: SubagentEventItem[];
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
    toolsByCallId: new Map(),
    toolInputs: new Map(),
    deltaTextByMsgId: new Map(),
    seenMessageIds: new Set(),
  };
}

export function deriveSubagentItems(
  historicalMessages: readonly SessionMessage[],
  liveEvents: readonly BrowserReplayEvent[],
  taskState: BackgroundTaskState,
): SubagentItem[] {
  const ordered: MutableSubagent[] = [];
  const byTaskId = new Map<string, MutableSubagent>();
  const byToolUseId = new Map<string, MutableSubagent>();
  const ignoredToolUseIds = new Set<string>();

  // 1. Seed from BackgroundTaskState (authoritative for live status, usage, elapsed).
  for (const task of taskState.tasks.values()) {
    if (task.ambient || task.skipTranscript === true) {
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
    acc.status = task.status;
    acc.startedAt = task.startedAt;
    acc.updatedAt = task.updatedAt;
    if (task.usage !== undefined) acc.usage = task.usage;
    if (task.summary !== undefined) acc.summary = task.summary;

    ordered.push(acc);
    byTaskId.set(task.taskId, acc);
    if (task.toolUseId !== undefined) byToolUseId.set(task.toolUseId, acc);
  }

  function ensureByToolUseId(toolUseId: string): MutableSubagent | undefined {
    if (ignoredToolUseIds.has(toolUseId)) return undefined;
    let acc = byToolUseId.get(toolUseId);
    if (acc === undefined) {
      acc = createEmptyAccumulator(toolUseId);
      acc.toolUseId = toolUseId;
      ordered.push(acc);
      byToolUseId.set(toolUseId, acc);
    }
    return acc;
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

  // Track which parentToolUseIds have live subagent events so we don't duplicate
  // historical replay on top of live events for the same subagent.
  const liveParentToolUseIds = new Set<string>();
  for (const event of liveEvents) {
    const payload = asRecord(event.payload) ?? {};
    const parentId = eventParentToolUseId(payload);
    if (parentId !== undefined) liveParentToolUseIds.add(parentId);
  }

  // 2. Scan historicalMessages for spawning Agent/Task calls and historical subagent streams.
  for (const message of historicalMessages) {
    if (message.type === "system") continue;
    const parentId = asString(message.parentToolUseId);
    const msg = asRecord(message.message);

    if (parentId === undefined) {
      // Main conversation message: check for Agent/Task tool_use or its tool_result.
      if (message.type === "assistant") {
        const content = msg?.["content"];
        if (Array.isArray(content)) {
          for (const block of content) {
            const rec = asRecord(block);
            if (rec?.["type"] !== "tool_use") continue;
            const id = asString(rec["id"]);
            const name = asString(rec["name"]);
            if (id === undefined || name === undefined || !isSubagentToolName(name)) continue;
            const acc = ensureByToolUseId(id);
            if (acc !== undefined) applySpawningInput(acc, asRecord(rec["input"]));
          }
        }
      } else if (message.type === "user") {
        for (const res of extractToolResults(msg)) {
          const acc = byToolUseId.get(res.toolUseId);
          if (acc === undefined) continue;
          if (!acc.hasTaskRecord) {
            acc.status = res.isError ? "failed" : "completed";
          }
          const text = extractResultSummary(res.content);
          if (acc.summary === undefined && text !== null && text.trim() !== "") {
            acc.summary = text.trim();
          }
        }
      }
      continue;
    }

    // Subagent historical message: skip if live events already cover this subagent.
    if (liveParentToolUseIds.has(parentId)) continue;
    const acc = ensureByToolUseId(parentId);
    if (acc === undefined) continue;

    if (message.type === "assistant") {
      const content = msg?.["content"];
      if (typeof content === "string") {
        if (content.trim() !== "") {
          acc.events.push({
            kind: "text",
            key: `${acc.id}-hist-text-${acc.events.length}`,
            text: content,
          });
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const rec = asRecord(block);
          if (rec === null) continue;
          if (rec["type"] === "thinking") {
            const thinking = asString(rec["thinking"]);
            if (thinking !== undefined) {
              acc.events.push({
                kind: "thinking",
                key: `${acc.id}-hist-thinking-${acc.events.length}`,
                text: thinking,
              });
            }
          } else if (rec["type"] === "tool_use") {
            const id = asString(rec["id"]);
            const name = asString(rec["name"]);
            if (id !== undefined && name !== undefined) {
              const input = asRecord(rec["input"]) ?? undefined;
              const step = buildToolStep(`${acc.id}-hist`, acc.events.length, id, name, input);
              acc.toolsByCallId.set(id, step);
              acc.events.push({ kind: "tool", key: step.key, step });
            }
          } else if (rec["type"] === "text") {
            const text = asString(rec["text"]);
            if (text !== undefined && text.trim() !== "") {
              acc.events.push({
                kind: "text",
                key: `${acc.id}-hist-text-${acc.events.length}`,
                text,
              });
            }
          }
        }
      }
    } else if (message.type === "user") {
      for (const res of extractToolResults(msg)) {
        const step = acc.toolsByCallId.get(res.toolUseId);
        if (step !== undefined) {
          step.state = res.isError ? "error" : "done";
          step.outputSummary = extractResultSummary(res.content);
        }
      }
    }
  }

  // 3. Scan liveEvents for spawning Agent/Task inputs/completions and live subagent events.
  for (const event of liveEvents) {
    const payload = asRecord(event.payload) ?? {};
    const parentId = eventParentToolUseId(payload);

    if (parentId === undefined) {
      // Main stream: pick up spawning Agent/Task metadata and tool completion fallback.
      if (event.type === "message.completed") {
        const msg = asRecord(payload["message"]);
        const content = msg?.["content"];
        if (Array.isArray(content)) {
          for (const block of content) {
            const rec = asRecord(block);
            if (rec?.["type"] !== "tool_use") continue;
            const id = asString(rec["id"]);
            const name = asString(rec["name"]);
            if (id === undefined || name === undefined || !isSubagentToolName(name)) continue;
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
        if (toolCallId !== undefined && toolName !== undefined && isSubagentToolName(toolName)) {
          const acc = ensureByToolUseId(toolCallId);
          if (acc !== undefined) {
            applySpawningInput(acc, asRecord(payload["input"]));
            acc.startedAt ??= event.occurredAt;
            acc.updatedAt = event.occurredAt;
          }
        }
      } else if (event.type === "tool.completed") {
        const toolCallId = asString(payload["toolCallId"]);
        if (toolCallId !== undefined) {
          const acc = byToolUseId.get(toolCallId);
          if (acc !== undefined) {
            if (!acc.hasTaskRecord) {
              acc.status = payload["isError"] === true ? "failed" : "completed";
              acc.updatedAt = event.occurredAt;
            }
            const outSummary = asString(payload["outputSummary"]);
            if (acc.summary === undefined && outSummary !== undefined) {
              acc.summary = outSummary;
            }
          }
        }
      }
      continue;
    }

    // Live subagent event: route into the subagent accumulator for `parentId`.
    const acc = ensureByToolUseId(parentId);
    if (acc === undefined) continue;
    acc.startedAt ??= event.occurredAt;
    if (!acc.hasTaskRecord) {
      acc.updatedAt = event.occurredAt;
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
      } else if (text.trim() !== "") {
        const index = acc.events.length;
        acc.deltaTextByMsgId.set(msgId, { index, text });
        acc.events.push({
          kind: "text",
          key: `${acc.id}-live-text-${msgId}-${index}`,
          text,
        });
      }
      continue;
    }

    if (event.type === "message.completed") {
      const msg = asRecord(payload["message"]);
      if (msg === null) continue;
      const msgId = asString(msg["id"]);
      const firstSeen = msgId === undefined || !acc.seenMessageIds.has(msgId);
      if (msgId !== undefined) acc.seenMessageIds.add(msgId);

      const content = msg["content"];
      if (Array.isArray(content)) {
        for (const block of content) {
          const rec = asRecord(block);
          if (rec === null) continue;
          if (rec["type"] === "thinking" && firstSeen) {
            const thinking = asString(rec["thinking"]);
            if (thinking !== undefined) {
              acc.events.push({
                kind: "thinking",
                key: `${acc.id}-live-thinking-${acc.events.length}`,
                text: thinking,
              });
            }
          } else if (rec["type"] === "tool_use") {
            const id = asString(rec["id"]);
            const inputRec = asRecord(rec["input"]);
            if (id !== undefined && inputRec !== null) {
              acc.toolInputs.set(id, inputRec);
              const existingStep = acc.toolsByCallId.get(id);
              if (existingStep !== undefined) {
                applyResolvedInput(existingStep, inputRec);
              }
            }
          }
        }
      }

      if (firstSeen && (msgId === undefined || !acc.deltaTextByMsgId.has(msgId))) {
        const prose = textFromBlocks(content);
        if (prose.trim() !== "") {
          acc.events.push({
            kind: "text",
            key: `${acc.id}-live-text-complete-${acc.events.length}`,
            text: prose,
          });
        }
      }
      continue;
    }

    if (event.type === "tool.started") {
      const toolCallId = asString(payload["toolCallId"]);
      const toolName = asString(payload["toolName"]);
      if (toolCallId === undefined || toolName === undefined) continue;
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
      acc.events.push({ kind: "tool", key: step.key, step });
      continue;
    }

    if (event.type === "tool.completed") {
      const toolCallId = asString(payload["toolCallId"]);
      if (toolCallId === undefined) continue;
      const step = acc.toolsByCallId.get(toolCallId);
      if (step === undefined) continue;
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
      ...(acc.usage === undefined ? {} : { usage: acc.usage }),
      ...(acc.summary === undefined ? {} : { summary: acc.summary }),
      ...(acc.prompt === undefined ? {} : { prompt: acc.prompt }),
      events: acc.events,
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
