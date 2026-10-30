/**
 * Pure chat-turn parser for the journal's bubble interface (§16.1, Task 13).
 *
 * `deriveChatTurns` fuses two sources into a flat, chronological list of
 * `ChatTurn`s:
 *
 *  - `historicalMessages: SessionMessage[]` — the resumed session's past
 *    transcript (the assistant/user/system messages the runner returns for
 *    `workspace.sessions.messages`).
 *  - `liveEvents: BrowserReplayEvent[]` — the live journal stream for a running
 *    or replayed run.
 *
 * The result is pure and deterministic: replaying the same inputs always
 * produces the same turns, which is what makes a resubscribed client's view
 * identical to a live one. This module is unit-tested directly (not via the
 * EventJournal SFC, which cannot compile under `bun test`).
 */
import type { AttachmentInfo, BrowserReplayEvent, SessionMessage } from "@cc-web/protocol";
import { parseAttachmentInfo } from "@cc-web/protocol";

export type ChatTurn = UserTurn | AgentTurn;

export type UserTurn = {
  kind: "user";
  key: string;
  uuid?: string;
  text: string;
  attachments?: AttachmentInfo[];
  rawPayload?: unknown;
};

export type AgentStep = ThinkingStep | ToolStep | ApprovalStep;

export type ThinkingStep = {
  kind: "thinking";
  key: string;
  text: string;
  durationMs?: number;
};

export type ToolStep = {
  kind: "tool";
  key: string;
  toolCallId: string;
  toolName: string;
  state: "running" | "done" | "error" | "interrupted";
  inputSummary?: string | null;
  outputSummary?: string | null;
  filePath?: string;
  command?: string;
  diffStats?: { added: number; removed: number };
  rawPayload?: unknown;
};

export type ApprovalStep = {
  kind: "approval";
  key: string;
  event: BrowserReplayEvent;
};

export type AgentTurn = {
  kind: "agent";
  key: string;
  runId?: string;
  status: "running" | "done" | "error" | "interrupted";
  durationText?: string;
  steps: AgentStep[];
  text: string;
  isStreaming?: boolean;
  rawPayload?: unknown;
};

/**
 * Strip Claude Code system wrappers (<command-*>, <local-command-*>, <system-reminder>, etc.)
 * from a user prompt and return the trimmed human text. Returns an empty string
 * for empty/whitespace-only input or pure system content.
 */
export function cleanUserPrompt(rawText: string): string {
  if (typeof rawText !== "string" || rawText.trim() === "") return "";

  let text = rawText;

  // 1. Strip entire caveat/system-reminder blocks (these should never appear in user bubble).
  text = text.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "");
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  text = text.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "");

  // 2. Command with name, message and optional args:
  // e.g. <command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>
  // Extract command name + args into a clean CLI string: "/clear" or "/model prime"
  text = text.replace(
    /<command-name>(.*?)<\/command-name>(?:\s*<command-message>[\s\S]*?<\/command-message>)?(?:\s*<command-args>(.*?)<\/command-args>)?/g,
    (_, name, args) => {
      const trimmedName = (name ?? "").trim();
      const trimmedArgs = (args ?? "").trim();
      return trimmedArgs !== "" ? `${trimmedName} ${trimmedArgs}` : trimmedName;
    },
  );

  // 3. Command stdout / stderr: unwrap content
  text = text.replace(/<\/?local-command-(stdout|stderr)>/g, "");

  // 4. Any leftover command tags
  text = text.replace(/<\/?command-(name|message|args)>/g, "");

  // 5. Injected attachment context block: if an older run recorded the injected block,
  // extract the actual user prompt following "User prompt:".
  if (text.startsWith("[Attached Files]") && text.includes("\n\nUser prompt:\n")) {
    const parts = text.split("\n\nUser prompt:\n");
    text = parts.slice(1).join("\n\nUser prompt:\n");
  }

  return text.trim();
}

/**
 * For an `Edit` tool input, compute added/removed line counts from
 * `new_string`/`old_string`. Returns `null` for non-Edit tools or when neither
 * field is present (Edit may legitimately add or remove content).
 */
export function extractDiffStats(
  toolName: string,
  input: Record<string, unknown> | undefined | null,
): { added: number; removed: number } | null {
  if (toolName !== "Edit") return null;
  const record = input ?? {};
  const oldString = record["old_string"];
  const newString = record["new_string"];
  if (oldString === undefined && newString === undefined) return null;

  const added =
    typeof newString === "string" && newString !== "" ? newString.split("\n").length : 0;
  const removed =
    typeof oldString === "string" && oldString !== "" ? oldString.split("\n").length : 0;
  return { added, removed };
}

/**
 * Format a millisecond duration into a compact human string.
 * `770000` -> "12m 50s", `3000` -> "3s", `500` -> "< 1s", `3600000` -> "1h 0m".
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return "< 1s";

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** The compact state the process accordion's collapsed row renders. */
export type ProcessSummary = {
  /** Thinking + tool steps; approval cards live outside the accordion. */
  count: number;
  /** One-line label of the step in flight, present only while the turn runs. */
  activeStepLabel?: string | undefined;
  hasError: boolean;
};

const MAX_STEP_LABEL_LENGTH = 80;

function truncateLabel(text: string): string {
  return text.length > MAX_STEP_LABEL_LENGTH ? `${text.slice(0, MAX_STEP_LABEL_LENGTH)}…` : text;
}

/**
 * One-line Vietnamese label for a tool step, e.g. `Sửa file: src/app.ts`.
 * Technical identifiers (paths, commands, tool names) stay verbatim.
 */
export function toolStepLabel(step: ToolStep): string {
  const detail = step.filePath ?? step.command ?? step.inputSummary ?? undefined;
  switch (step.toolName) {
    case "Edit":
    case "Write":
      return truncateLabel(`Sửa file: ${detail ?? step.toolName}`);
    case "Read":
      return truncateLabel(`Đọc file: ${detail ?? step.toolName}`);
    case "Bash":
      return truncateLabel(`Chạy: ${step.command ?? detail ?? "lệnh"}`);
    case "Grep":
    case "Glob":
      return truncateLabel(`Tìm: ${detail ?? step.toolName}`);
    default:
      return truncateLabel(detail !== undefined ? `${step.toolName}: ${detail}` : step.toolName);
  }
}

/**
 * Fold an agent turn's steps into what the collapsed accordion row shows: how
 * many execution steps there are, which one is in flight, and whether anything
 * failed. Pure, so the collapsed badge replays exactly like the live one.
 */
export function summarizeProcessState(
  steps: readonly AgentStep[],
  status: AgentTurn["status"],
): ProcessSummary {
  const executionSteps = steps.filter((step) => step.kind !== "approval");
  const hasError =
    status === "error" ||
    executionSteps.some((step) => step.kind === "tool" && step.state === "error");

  let activeStepLabel: string | undefined;
  if (status === "running") {
    // Only a step still in flight can be named as "running": a settled tool
    // shown under "Đang chạy" would claim work that already finished.
    const lastRunningTool = executionSteps.findLast(
      (step) => step.kind === "tool" && step.state === "running",
    );
    const last = executionSteps[executionSteps.length - 1];
    if (lastRunningTool !== undefined && lastRunningTool.kind === "tool") {
      activeStepLabel = toolStepLabel(lastRunningTool);
    } else if (last?.kind === "thinking") {
      activeStepLabel = "Đang suy nghĩ…";
    }
  }

  return { count: executionSteps.length, activeStepLabel, hasError };
}

/**
 * The accordion's one-line summary. A run parked on an approval says so before
 * naming any step: "Đang chạy" while nothing can run is a lie the operator acts
 * on.
 */
export function processSummaryLabel(
  status: AgentTurn["status"],
  summary: ProcessSummary,
  pendingApprovalCount = 0,
): string {
  if (status === "running") {
    if (pendingApprovalCount > 0) return "Đang chờ phê duyệt…";
    return summary.activeStepLabel !== undefined
      ? `Đang chạy: ${summary.activeStepLabel}`
      : "Đang chạy…";
  }
  if (status === "error") return `Lỗi sau ${summary.count} bước thực hiện`;
  if (status === "interrupted") return `Đã dừng sau ${summary.count} bước thực hiện`;
  return `Đã hoàn thành ${summary.count} bước thực hiện`;
}

/**
 * Whether the accordion's body renders. A turn with no execution steps has
 * nothing to collapse, so its approval cards must stay visible even when the
 * settled-state default is "closed" — otherwise a replayed approval-only turn
 * silently loses its card.
 */
export function processBodyVisible(isOpen: boolean, executionStepCount: number): boolean {
  return isOpen || executionStepCount === 0;
}

const RUN_TERMINALS: ReadonlySet<string> = new Set([
  "run.finished",
  "run.failed",
  "run.interrupted",
]);

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Extract and validate an `AttachmentInfo[]` from a raw payload value.
 * Returns `undefined` when the value is absent, malformed, or contains any
 * entry that fails `parseAttachmentInfo`. A partially understood batch would
 * let one bad entry look like a complete set, so the whole list is refused.
 */
function extractAttachments(value: unknown): AttachmentInfo[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const items: AttachmentInfo[] = [];
  for (const entry of value) {
    const parsed = parseAttachmentInfo(entry);
    if (parsed === undefined) return undefined;
    items.push(parsed);
  }
  return items.length > 0 ? items : undefined;
}

/** Extract text from a content block array (Anthropic shape). */
function textFromContentBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record["type"] !== "text") continue;
    const text = record["text"];
    if (typeof text === "string" && text !== "") texts.push(text);
  }
  return texts.join("\n\n");
}

/** Read the user prompt text from a `user` SessionMessage, tolerant of shapes. */
function userPromptText(message: SessionMessage): string {
  const msg = asRecord(message.message);
  if (msg === null) return "";
  // A bare tool_result block is never a user prompt.
  if (msg["type"] === "tool_result") return "";
  return textFromContentBlocks(msg["content"]);
}

/** Read the assistant prose from an `assistant` SessionMessage. */
function assistantProse(message: SessionMessage): string {
  const msg = asRecord(message.message);
  if (msg === null) return "";
  return textFromContentBlocks(msg["content"]);
}

type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown> | undefined;
};

/** Collect tool_use blocks from an assistant message's content array. */
function toolUseBlocksOf(message: SessionMessage): ToolUseBlock[] {
  const msg = asRecord(message.message);
  if (msg === null) return [];
  const content = msg["content"];
  if (!Array.isArray(content)) return [];
  const blocks: ToolUseBlock[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record["type"] !== "tool_use") continue;
    const id = asString(record["id"]);
    const name = asString(record["name"]);
    if (id === undefined || name === undefined) continue;
    const input = asRecord(record["input"]);
    blocks.push({ type: "tool_use", id, name, input: input ?? undefined });
  }
  return blocks;
}

/** Collect thinking blocks from an assistant message's content array. */
function thinkingBlocksOf(message: SessionMessage): string[] {
  const msg = asRecord(message.message);
  if (msg === null) return [];
  const content = msg["content"];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record["type"] !== "thinking") continue;
    const thinking = record["thinking"];
    if (typeof thinking === "string" && thinking !== "") texts.push(thinking);
  }
  return texts;
}

function extractToolField(
  name: string,
  input?: Record<string, unknown> | null,
): string | undefined {
  const record = input ?? {};
  if (name === "Bash") return asString(record["command"]);
  if (name === "Edit" || name === "Write" || name === "Read") return asString(record["filePath"]);
  if (name === "Grep" || name === "Glob") {
    const pattern = asString(record["pattern"]);
    if (pattern !== undefined) return pattern;
    return asString(record["path"]);
  }
  return undefined;
}

/**
 * Summarize a tool_use input into a compact string for display.
 * Bash -> command, Edit/Write/Read -> filePath, Grep/Glob -> pattern/path.
 */
function summarizeToolInput(name: string, input: Record<string, unknown>[]): string | null {
  const record = input[0] ?? {};
  // Build a representative summary: the most relevant field for each tool kind.
  const field = extractToolField(name, record as Record<string, unknown> | undefined);
  if (field !== undefined) return field;
  // Fallback: JSON of the whole input (redacted of nothing here — the executor
  // already redacted secrets before persistence).
  try {
    const json = JSON.stringify(record);
    return json.length > 240 ? `${json.slice(0, 240)}…` : json;
  } catch {
    return null;
  }
}

type PendingTool = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown> | undefined;
  /** True when a `message.completed` retroactively supplied the input. */
  inputUpdated: boolean;
  outputSummary: string | null;
  isError: boolean;
  completed: boolean;
};

type ToolResultBlock = {
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
};

/**
 * Extract tool_result blocks from a user message.
 * Handles both bare tool_result blocks and Anthropic user messages with a content array.
 */
function toolResultsFrom(message: Record<string, unknown> | null): ToolResultBlock[] {
  if (message === null) return [];
  // Bare tool_result block
  if (message["type"] === "tool_result" && typeof message["tool_use_id"] === "string") {
    return [
      {
        tool_use_id: message["tool_use_id"],
        content: message["content"],
        is_error: message["is_error"] === true,
      },
    ];
  }
  // Anthropic user message with content array
  const content = message["content"];
  if (Array.isArray(content)) {
    const results: ToolResultBlock[] = [];
    for (const item of content) {
      if (typeof item === "object" && item !== null) {
        const record = item as Record<string, unknown>;
        if (record["type"] === "tool_result" && typeof record["tool_use_id"] === "string") {
          results.push({
            tool_use_id: record["tool_use_id"],
            content: record["content"],
            is_error: record["is_error"] === true,
          });
        }
      }
    }
    return results;
  }
  return [];
}

/** Flatten a tool_result content (string or array of text blocks) into a summary string. */
function extractToolResultSummary(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (typeof block === "object" && block !== null) {
        const rec = block as Record<string, unknown>;
        if (rec["type"] === "text" && typeof rec["text"] === "string") {
          texts.push(rec["text"]);
        }
      }
    }
    return texts.length > 0 ? texts.join("\n") : null;
  }
  if (content !== undefined && content !== null) {
    try {
      return JSON.stringify(content);
    } catch {
      return null;
    }
  }
  return null;
}

/** Find the index of the first historical turn that overlaps with live events. */
function findHistoricalOverlapIndex(
  turns: readonly ChatTurn[],
  liveToolIds: ReadonlySet<string>,
  liveMessageIds: ReadonlySet<string>,
  livePrompts: ReadonlySet<string>,
): number {
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    if (turn.kind === "agent") {
      const hasMatchingTool = turn.steps.some(
        (s) => s.kind === "tool" && liveToolIds.has(s.toolCallId),
      );
      const msg = asRecord(turn.rawPayload);
      const hasMatchingMsgId =
        typeof msg?.["id"] === "string" && liveMessageIds.has(msg["id"] as string);
      if (hasMatchingTool || hasMatchingMsgId) {
        if (i > 0 && turns[i - 1]?.kind === "user") {
          return i - 1;
        }
        return i;
      }
    } else if (turn.kind === "user") {
      if (livePrompts.has(turn.text)) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Convert historical `SessionMessage[]` + live `BrowserReplayEvent[]` into a
 * chronological list of `ChatTurn`s.
 *
 * Deduplication: When liveEvents are present, any historical turns that correspond
 * to runs covered by liveEvents are superseded by the richer live turns (which have
 * status, duration, live steps, and interactive approvals).
 *
 * Live phase: `run.started` emits a `UserTurn` (from `payload.prompt`) immediately
 * followed by a running `AgentTurn`. Terminal events finalize the turn with duration.
 */
export function deriveChatTurns(
  historicalMessages: readonly SessionMessage[],
  liveEvents: readonly BrowserReplayEvent[],
  pendingRun?: { runId: string; prompt: string; attachments?: AttachmentInfo[] },
): ChatTurn[] {
  // Collect identifiers from liveEvents to detect overlap with historicalMessages.
  const liveToolIds = new Set<string>();
  const liveMessageIds = new Set<string>();
  const livePrompts = new Set<string>();
  let hasLiveRuns = false;

  for (const event of liveEvents) {
    const payload = asRecord(event.payload) ?? {};
    if (event.type === "run.started") {
      hasLiveRuns = true;
      const prompt = asString(payload["prompt"]);
      if (prompt !== undefined && prompt !== "") {
        const cleaned = cleanUserPrompt(prompt);
        if (cleaned !== "") livePrompts.add(cleaned);
      }
    }
    if (event.type === "message.started" || event.type === "message.delta") {
      const id = asString(payload["messageId"]);
      if (id !== undefined) liveMessageIds.add(id);
    }
    if (event.type === "message.completed") {
      const msg = asRecord(payload["message"]);
      if (msg !== null) {
        const id = asString(msg["id"]);
        if (id !== undefined) liveMessageIds.add(id);
        const content = msg["content"];
        if (Array.isArray(content)) {
          for (const block of content) {
            const rec = asRecord(block);
            if (rec?.["type"] === "tool_use" && typeof rec["id"] === "string") {
              liveToolIds.add(rec["id"]);
            }
          }
        }
      }
    }
    if (event.type === "tool.started" || event.type === "tool.completed") {
      const toolCallId = asString(payload["toolCallId"]);
      if (toolCallId !== undefined) liveToolIds.add(toolCallId);
    }
  }

  // --- Historical replay -------------------------------------------------
  const historicalTurns: ChatTurn[] = [];
  let currentAgentTurn: AgentTurn | null = null;
  const pendingTools = new Map<string, PendingTool>();

  for (const message of historicalMessages) {
    if (message.type === "system") continue;

    if (message.type === "user") {
      const msg = asRecord(message.message);
      const toolResults = toolResultsFrom(msg);

      if (toolResults.length > 0) {
        for (const res of toolResults) {
          const pending = pendingTools.get(res.tool_use_id);
          if (pending !== undefined) {
            pending.outputSummary = extractToolResultSummary(res.content);
            pending.isError = res.is_error === true;
            pending.completed = true;
          }
        }
        // If content consists solely of tool results, do not create a user bubble.
        const prose = cleanUserPrompt(userPromptText(message));
        if (prose === "") continue;
      }

      const text = cleanUserPrompt(userPromptText(message));
      if (text === "") continue;

      // Real user prose: flush any in-flight agent turn first.
      if (currentAgentTurn !== null) {
        finalizeAgentTurn(currentAgentTurn, pendingTools);
        historicalTurns.push(currentAgentTurn);
        currentAgentTurn = null;
      }

      historicalTurns.push({
        kind: "user",
        key: `history-${message.uuid}`,
        uuid: message.uuid,
        text,
        rawPayload: message.message,
      });
      continue;
    }

    // assistant
    const prose = assistantProse(message);
    const thinkingBlocks = thinkingBlocksOf(message);
    const toolUses = toolUseBlocksOf(message);

    let agent: AgentTurn | null = currentAgentTurn;
    if (agent === null) {
      agent = {
        kind: "agent",
        key: `history-${message.uuid}`,
        status: "done",
        steps: [],
        text: prose,
        isStreaming: false,
        rawPayload: message.message,
      };
      currentAgentTurn = agent;
    } else {
      // Append to the open agent turn (consecutive assistant messages).
      if (prose !== "") {
        agent.text = agent.text === "" ? prose : `${agent.text}\n\n${prose}`;
      }
    }

    for (const block of thinkingBlocks) {
      agent.steps.push({
        kind: "thinking",
        key: `${agent.key}-thinking-${agent.steps.length}`,
        text: block,
      });
    }

    for (const toolUse of toolUses) {
      const stepKey = `${agent.key}-tool-${agent.steps.length}`;
      const toolStep: ToolStep = {
        kind: "tool",
        key: stepKey,
        toolCallId: toolUse.id,
        toolName: toolUse.name,
        state: "running",
        inputSummary: summarizeToolInput(toolUse.name, [toolUse.input ?? {}]),
        outputSummary: null,
        rawPayload: toolUse.input,
      };
      const filePath = extractToolField(toolUse.name, toolUse.input);
      if (filePath !== undefined) {
        if (toolUse.name === "Bash") toolStep.command = filePath;
        else toolStep.filePath = filePath;
      }
      const diffStats = extractDiffStats(toolUse.name, toolUse.input);
      if (diffStats !== null) toolStep.diffStats = diffStats;

      agent.steps.push(toolStep);
      pendingTools.set(toolUse.id, {
        toolCallId: toolUse.id,
        toolName: toolUse.name,
        input: toolUse.input,
        inputUpdated: false,
        outputSummary: null,
        isError: false,
        completed: false,
      });
    }
  }

  // Flush a trailing historical agent turn.
  if (currentAgentTurn !== null) {
    finalizeAgentTurn(currentAgentTurn, pendingTools);
    historicalTurns.push(currentAgentTurn);
    currentAgentTurn = null;
  }

  // --- Deduplicate history against live runs -----------------------------
  const turns: ChatTurn[] = [];
  const unconsumedHistoricalPrompts: string[] = [];

  if (hasLiveRuns) {
    const overlapIdx = findHistoricalOverlapIndex(
      historicalTurns,
      liveToolIds,
      liveMessageIds,
      livePrompts,
    );
    if (overlapIdx >= 0) {
      // Keep only historical turns before the first live run.
      turns.push(...historicalTurns.slice(0, overlapIdx));
      // For any superseded turns, gather user prompts to backfill legacy live events lacking prompt.
      for (const t of historicalTurns.slice(overlapIdx)) {
        if (t.kind === "user" && t.text !== "") {
          unconsumedHistoricalPrompts.push(t.text);
        }
      }
    } else {
      turns.push(...historicalTurns);
    }
  } else {
    turns.push(...historicalTurns);
  }

  // --- Live events ------------------------------------------------------
  let liveAgentTurn: AgentTurn | null = null;
  const livePendingTools = new Map<string, PendingTool>();
  const liveToolInputs = new Map<string, Record<string, unknown>>();

  for (const event of liveEvents) {
    const payload = asRecord(event.payload) ?? {};

    if (event.type === "run.started") {
      if (liveAgentTurn !== null) {
        finalizeAgentTurn(liveAgentTurn, livePendingTools, liveToolInputs);
        turns.push(liveAgentTurn);
      }

      // Live user turn from payload.prompt (or legacy fallback from history).
      const rawPrompt = asString(payload["prompt"]);
      let promptText = rawPrompt ? cleanUserPrompt(rawPrompt) : "";
      if (promptText === "" && unconsumedHistoricalPrompts.length > 0) {
        promptText = unconsumedHistoricalPrompts.shift() ?? "";
      } else if (unconsumedHistoricalPrompts.length > 0) {
        unconsumedHistoricalPrompts.shift();
      }

      const attachments = extractAttachments(payload["attachments"]);

      if (promptText !== "") {
        turns.push({
          kind: "user",
          key: `live-user-${event.runId}`,
          text: promptText,
          ...(attachments === undefined ? {} : { attachments }),
          rawPayload: event.payload,
        });
      }

      liveAgentTurn = {
        kind: "agent",
        key: `live-${event.runId}`,
        status: "running",
        runId: event.runId,
        steps: [],
        text: "",
        isStreaming: true,
        rawPayload: event.payload,
      };
      continue;
    }

    if (RUN_TERMINALS.has(event.type)) {
      if (liveAgentTurn !== null) {
        liveAgentTurn.status =
          event.type === "run.finished"
            ? "done"
            : event.type === "run.failed"
              ? "error"
              : "interrupted";
        liveAgentTurn.isStreaming = false;
        const durationMs = payload["durationMs"];
        if (typeof durationMs === "number") {
          liveAgentTurn.durationText = formatDuration(durationMs);
        }
        finalizeAgentTurn(liveAgentTurn, livePendingTools, liveToolInputs);
        turns.push(liveAgentTurn);
        liveAgentTurn = null;
      }
      continue;
    }

    if (liveAgentTurn === null) continue;

    if (event.type === "message.started") {
      continue;
    }

    if (event.type === "message.delta") {
      const text = asString(payload["text"]);
      if (text !== undefined) liveAgentTurn.text += text;
      continue;
    }

    if (event.type === "message.completed") {
      const msg = asRecord(payload["message"]);
      if (msg !== null) {
        const content = msg["content"];
        if (liveAgentTurn.text === "") {
          const prose = textFromContentBlocks(content);
          if (prose !== "") liveAgentTurn.text = prose;
        }
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block !== "object" || block === null) continue;
            const record = block as Record<string, unknown>;
            if (record["type"] !== "tool_use") continue;
            const id = asString(record["id"]);
            if (id === undefined) continue;
            const inputRecord = asRecord(record["input"]);
            if (inputRecord !== null) liveToolInputs.set(id, inputRecord);
          }
        }
      }
      continue;
    }

    if (event.type === "tool.started") {
      const toolCallId = asString(payload["toolCallId"]);
      const toolName = asString(payload["toolName"]);
      if (toolCallId === undefined || toolName === undefined) continue;
      const preCollected = liveToolInputs.get(toolCallId);
      const rawInput = payload["input"];
      const inputRecord = preCollected ?? asRecord(rawInput);
      if (inputRecord !== null) {
        liveAgentTurn.steps.push(
          newLiveToolStep(
            liveAgentTurn.key,
            liveAgentTurn.steps.length,
            toolCallId,
            toolName,
            inputRecord,
          ),
        );
        livePendingTools.set(toolCallId, {
          toolCallId,
          toolName,
          input: inputRecord,
          inputUpdated: preCollected !== undefined,
          outputSummary: null,
          isError: false,
          completed: false,
        });
      } else {
        liveAgentTurn.steps.push(
          newLiveToolStep(
            liveAgentTurn.key,
            liveAgentTurn.steps.length,
            toolCallId,
            toolName,
            undefined,
          ),
        );
        livePendingTools.set(toolCallId, {
          toolCallId,
          toolName,
          input: undefined,
          inputUpdated: false,
          outputSummary: null,
          isError: false,
          completed: false,
        });
      }
      continue;
    }

    if (event.type === "tool.completed") {
      const toolCallId = asString(payload["toolCallId"]);
      if (toolCallId === undefined) continue;
      const pending = livePendingTools.get(toolCallId);
      if (pending === undefined) continue;
      pending.outputSummary = asString(payload["outputSummary"]) ?? null;
      pending.isError = payload["isError"] === true;
      pending.completed = true;
      const completedInput = asRecord(payload["input"]);
      if (completedInput !== null && !pending.inputUpdated) {
        pending.input = completedInput;
        pending.inputUpdated = true;
      }
      continue;
    }

    if (event.type === "approval.requested") {
      liveAgentTurn.steps.push({
        kind: "approval",
        key: `${liveAgentTurn.key}-approval-${liveAgentTurn.steps.length}`,
        event,
      });
    }
  }

  if (liveAgentTurn !== null) {
    finalizeAgentTurn(liveAgentTurn, livePendingTools, liveToolInputs);
    turns.push(liveAgentTurn);
  }

  // If a run was just started from the composer but run.started has not reached
  // the live event stream yet, render an optimistic user prompt and running agent turn.
  if (
    pendingRun !== undefined &&
    pendingRun.prompt.trim() !== "" &&
    !liveEvents.some((e) => e.runId === pendingRun.runId)
  ) {
    turns.push({
      key: `user-pending-${pendingRun.runId}`,
      kind: "user",
      text: cleanUserPrompt(pendingRun.prompt),
      ...(pendingRun.attachments === undefined ? {} : { attachments: pendingRun.attachments }),
    });
    turns.push({
      key: `agent-pending-${pendingRun.runId}`,
      kind: "agent",
      status: "running",
      isStreaming: true,
      steps: [],
      text: "",
    });
  }

  return turns;
}

function newLiveToolStep(
  turnKey: string,
  index: number,
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown> | undefined,
): ToolStep {
  const step: ToolStep = {
    kind: "tool",
    key: `${turnKey}-tool-${index}`,
    toolCallId,
    toolName,
    state: "running",
    inputSummary: summarizeToolInput(toolName, [input ?? {}]),
    outputSummary: null,
    rawPayload: input,
  };
  const filePath = extractToolField(toolName, input);
  if (filePath !== undefined) {
    if (toolName === "Bash") step.command = filePath;
    else step.filePath = filePath;
  }
  const diffStats = extractDiffStats(toolName, input);
  if (diffStats !== null) step.diffStats = diffStats;
  return step;
}

/**
 * Settle an agent turn's tool steps from pending-tool results. Called once the
 * turn is complete (the next user message, a run terminal, or end of input).
 */
function finalizeAgentTurn(
  agentTurn: AgentTurn,
  pendingTools: Map<string, PendingTool>,
  toolInputs?: Map<string, Record<string, unknown>>,
): void {
  for (const step of agentTurn.steps) {
    if (step.kind !== "tool") continue;
    const pending = pendingTools.get(step.toolCallId);
    if (pending !== undefined) {
      step.state = pending.completed ? (pending.isError ? "error" : "done") : "running";
      step.outputSummary = pending.outputSummary;
    }

    // The input may have been retroactively collected from a `message.completed`
    // event or a `tool.completed` payload (the SDK can emit complete frames before
    // raw tool.started). Re-derive the display fields from the now-complete input.
    let resolvedInput: Record<string, unknown> | undefined;
    if (pending?.inputUpdated && pending.input !== undefined) {
      resolvedInput = pending.input;
    } else if (pending?.input !== undefined) {
      resolvedInput = pending.input;
    } else {
      resolvedInput = toolInputs?.get(step.toolCallId);
    }
    if (resolvedInput !== undefined) {
      step.rawPayload = resolvedInput;
      step.inputSummary = summarizeToolInput(step.toolName, [resolvedInput]);
      const filePath = extractToolField(step.toolName, resolvedInput);
      if (filePath !== undefined) {
        if (step.toolName === "Bash") step.command = filePath;
        else step.filePath = filePath;
      }
      const diffStats = extractDiffStats(step.toolName, resolvedInput);
      if (diffStats !== null) step.diffStats = diffStats;
    }
  }
  pendingTools.clear();
  toolInputs?.clear();
}
