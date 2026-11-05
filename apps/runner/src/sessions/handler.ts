/**
 * Claude Code session inspection handler.
 *
 * Answers `workspace.sessions.list` and `workspace.sessions.messages` RPC commands
 * by querying the Claude Agent SDK (§12 session discovery surface). This handler
 * mirrors the inspection and browse handlers' idiom: the `rpc.result` frame is the
 * only channel back to the server, so every failure becomes
 * `{ ok: false, error: { code, message } }` and the handler never throws — a throw
 * would leave the server's waiter to time out with no explanation, and the message
 * is redacted because a thrown error can quote an environment variable or token (§19.4).
 *
 * Path resolution follows the same pattern as the inspection handler: the command
 * names a `workspaceId` (which the runner resolves through `workspacePathFor`) or a
 * directory path, and `path.resolve` normalizes the remainder before the SDK is
 * asked to enumerate sessions for it.
 */

import { resolve } from "node:path";
import {
  parseSessionsRequest,
  type RpcResultFrame,
  SESSIONS_CAPABILITY,
  SESSIONS_LIST_DEFAULT_LIMIT,
  SESSIONS_LIST_MAX_LIMIT,
  SESSIONS_MESSAGES_DEFAULT_LIMIT,
  SESSIONS_MESSAGES_MAX_LIMIT,
  type SessionMessage,
  type SessionMessagesRequest,
  type SessionMessagesResult,
  type SessionSummary,
  type SessionsListRequest,
  type SessionsListResult,
} from "@cc-web/protocol";
import { redactErrorText, redactSdkMessage } from "../execution/redact.ts";

const MAX_SUBAGENTS_PER_SESSION = 30;
const MAX_SUBAGENT_MESSAGES_LIMIT = 100;

/** The subset of the Claude Agent SDK this handler uses. */
export type SessionsSdk = {
  listSessions(options: {
    dir: string;
    limit: number;
    offset?: number;
    includeProgrammatic: false;
  }): Promise<SDKSessionInfoLike[]>;
  getSessionMessages(
    sessionId: string,
    options: {
      dir?: string;
      limit: number;
      offset?: number;
      includeSystemMessages: false;
    },
  ): Promise<SDKSessionMessage[]>;
  listSubagents?(sessionId: string, options?: { dir?: string }): Promise<string[]>;
  getSubagentMessages?(
    sessionId: string,
    agentId: string,
    options?: { dir?: string; limit?: number; offset?: number },
  ): Promise<SDKSessionMessage[]>;
};

/** Mirrors the SDK's `SDKSessionInfo` shape for the fields we project. */
type SDKSessionInfoLike = {
  sessionId: string;
  summary: string;
  lastModified: number;
  gitBranch?: string;
  cwd?: string;
  createdAt?: number;
};

/** Mirrors the SDK's `SessionMessage` shape for the fields we project. */
type SDKSessionMessage = {
  type: "user" | "assistant" | "system";
  uuid: string;
  message: unknown;
  parent_tool_use_id?: string | null;
  agent_id?: string | null;
};

export type SessionsHandlerOptions = {
  /** The runner's workspace registration seam — the same one `run.start` resolves through. */
  workspacePathFor: (workspaceId: string) => string | undefined;
  /**
   * Optional SDK seam. When absent the real
   * `@anthropic-ai/claude-agent-sdk` is loaded lazily so tests never pay the
   * cost of importing the bundled binary.
   */
  sdk?: SessionsSdk;
};

/** Advisory: which optional command kinds this runner implements. */
export const SESSIONS_CAPABILITIES: string[] = [SESSIONS_CAPABILITY];

/** The command kinds this handler owns; anything else is not its to answer. */
const SESSIONS_KINDS = new Set(["workspace.sessions.list", "workspace.sessions.messages"]);

export function createSessionsHandler(
  options: SessionsHandlerOptions,
): (command: unknown) => Promise<RpcResultFrame> {
  function refuse(commandId: string, code: string, message: string): RpcResultFrame {
    return { type: "rpc.result", commandId, ok: false, error: { code, message } };
  }

  function answer(
    commandId: string,
    result: SessionsListResult | SessionMessagesResult,
  ): RpcResultFrame {
    return { type: "rpc.result", commandId, ok: true, result };
  }

  return async function handle(command: unknown): Promise<RpcResultFrame> {
    const record =
      typeof command === "object" && command !== null
        ? (command as Record<string, unknown>)
        : undefined;
    const commandId = typeof record?.["commandId"] === "string" ? record["commandId"] : "";

    if (record === undefined)
      return refuse(commandId, "UNSUPPORTED_COMMAND", "command must be an object");

    const kind = record["kind"];
    if (typeof kind !== "string" || !SESSIONS_KINDS.has(kind)) {
      return refuse(commandId, "UNSUPPORTED_COMMAND", "not a sessions command");
    }

    const request = parseSessionsRequest(kind, record["payload"]);
    if (request === undefined) {
      return refuse(commandId, "UNSUPPORTED_COMMAND", "unrecognised sessions payload");
    }

    try {
      return await dispatch(commandId, request, options);
    } catch (error) {
      // A throw here is a bug or a dying SDK — never a result the server can act on.
      // Redact so a credential-quoting error never reaches the journal (§19.4).
      const message = redactErrorText(error instanceof Error ? error.message : String(error));
      return refuse(commandId, "SDK_ERROR", message.slice(0, 500));
    }
  };

  async function dispatch(
    commandId: string,
    request: SessionsListRequest | SessionMessagesRequest,
    options: SessionsHandlerOptions,
  ): Promise<RpcResultFrame> {
    const sdk = resolveSdk(options);

    switch (request.op) {
      case "sessions.list": {
        const listRequest = request as SessionsListRequest;
        const resolved = options.workspacePathFor(listRequest.dir) ?? listRequest.dir;
        const dir = resolve(resolved);
        const limit = clampLimit(
          listRequest.limit,
          SESSIONS_LIST_DEFAULT_LIMIT,
          SESSIONS_LIST_MAX_LIMIT,
        );

        const sessions = await sdk.listSessions({
          dir,
          limit,
          ...(listRequest.offset !== undefined ? { offset: listRequest.offset } : {}),
          includeProgrammatic: false,
        });

        const mapped: SessionSummary[] = sessions.map(toSessionSummary);
        return answer(commandId, { op: "sessions.list", dir, sessions: mapped });
      }

      case "sessions.messages": {
        const msgRequest = request as SessionMessagesRequest;
        let resolvedDir: string | undefined;
        if (msgRequest.dir !== undefined) {
          resolvedDir = resolve(options.workspacePathFor(msgRequest.dir) ?? msgRequest.dir);
        }
        const limit = clampLimit(
          msgRequest.limit,
          SESSIONS_MESSAGES_DEFAULT_LIMIT,
          SESSIONS_MESSAGES_MAX_LIMIT,
        );

        const messages = await sdk.getSessionMessages(msgRequest.sessionId, {
          ...(resolvedDir !== undefined ? { dir: resolvedDir } : {}),
          limit,
          ...(msgRequest.offset !== undefined ? { offset: msgRequest.offset } : {}),
          includeSystemMessages: false,
        });

        const mapped: SessionMessage[] = messages.map((msg) => toSessionMessage(msg));

        if (
          (msgRequest.offset === undefined || msgRequest.offset === 0) &&
          sdk.listSubagents !== undefined &&
          sdk.getSubagentMessages !== undefined
        ) {
          const subagentMessages = await loadSubagentSessionMessages(
            sdk as Required<Pick<SessionsSdk, "listSubagents" | "getSubagentMessages">>,
            msgRequest.sessionId,
            resolvedDir,
            Math.min(limit, MAX_SUBAGENT_MESSAGES_LIMIT),
            messages,
          );
          mapped.push(...subagentMessages);
        }

        const result: SessionMessagesResult = {
          op: "sessions.messages",
          sessionId: msgRequest.sessionId,
          messages: mapped,
        };
        return answer(commandId, result);
      }
    }
  }
}

function resolveSdk(options: SessionsHandlerOptions): SessionsSdk {
  if (options.sdk !== undefined) return options.sdk;
  // Lazy require so importing this module in tests does not load the bundled
  // binary. `require` is Bun's synchronous loader (§20.3).
  return require("@anthropic-ai/claude-agent-sdk") as SessionsSdk;
}

function clampLimit(value: number | undefined, defaultLimit: number, maxLimit: number): number {
  if (value === undefined) return defaultLimit;
  if (value < 1) return 1;
  if (value > maxLimit) return maxLimit;
  return value;
}

function toSessionSummary(sdk: SDKSessionInfoLike): SessionSummary {
  const summary: SessionSummary = {
    sessionId: sdk.sessionId,
    summary: sdk.summary,
    lastModified: sdk.lastModified,
  };
  if (sdk.gitBranch !== undefined) summary.gitBranch = sdk.gitBranch;
  if (sdk.cwd !== undefined) summary.cwd = sdk.cwd;
  if (sdk.createdAt !== undefined) summary.createdAt = sdk.createdAt;
  return summary;
}

function redactMessageField(value: unknown): unknown {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return redactSdkMessage(value);
  }
  if (typeof value === "string") {
    return redactErrorText(value);
  }
  return value;
}

function toSessionMessage(
  msg: SDKSessionMessage,
  extra?: { agentId?: string; parentToolUseId?: string },
): SessionMessage {
  const out: SessionMessage = {
    type: msg.type,
    uuid: msg.uuid,
    message: redactMessageField(msg.message),
  };
  const parentId =
    typeof msg.parent_tool_use_id === "string" && msg.parent_tool_use_id !== ""
      ? msg.parent_tool_use_id
      : extra?.parentToolUseId;
  if (parentId !== undefined && parentId !== "") {
    out.parentToolUseId = parentId;
  }
  const agentId =
    typeof msg.agent_id === "string" && msg.agent_id !== "" ? msg.agent_id : extra?.agentId;
  if (agentId !== undefined && agentId !== "") {
    out.agentId = agentId;
  }
  return out;
}

function isHousekeepingSubagentId(agentId: string): boolean {
  return (
    agentId.startsWith("acompact-") ||
    agentId.startsWith("aprompt_suggestion-") ||
    agentId.startsWith("aside_question-")
  );
}

function flattenResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "object" && item !== null) {
      const rec = item as Record<string, unknown>;
      if (rec["type"] === "text" && typeof rec["text"] === "string") {
        parts.push(rec["text"]);
      }
    }
  }
  return parts.join("\n");
}

function extractAgentIdToToolUseIdMap(
  mainMessages: readonly SDKSessionMessage[],
): Map<string, string> {
  const subagentToolUseIds = new Set<string>();
  const agentIdToToolUseId = new Map<string, string>();

  for (const msg of mainMessages) {
    if (typeof msg.message !== "object" || msg.message === null) continue;
    const content = (msg.message as Record<string, unknown>)["content"];
    if (!Array.isArray(content)) continue;

    if (msg.type === "assistant") {
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const rec = block as Record<string, unknown>;
        if (rec["type"] !== "tool_use") continue;
        const id = rec["id"];
        const name = rec["name"];
        if (typeof id === "string" && (name === "Agent" || name === "Task")) {
          subagentToolUseIds.add(id);
        }
      }
    } else if (msg.type === "user") {
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const rec = block as Record<string, unknown>;
        if (rec["type"] !== "tool_result") continue;
        const toolUseId = rec["tool_use_id"];
        if (typeof toolUseId !== "string" || !subagentToolUseIds.has(toolUseId)) continue;
        const text = flattenResultText(rec["content"]);
        const match = /\bagentId:\s*([A-Za-z0-9_-]+)/.exec(text);
        if (match?.[1] !== undefined) {
          agentIdToToolUseId.set(match[1], toolUseId);
        }
      }
    }
  }

  return agentIdToToolUseId;
}

async function loadSubagentSessionMessages(
  sdk: Required<Pick<SessionsSdk, "listSubagents" | "getSubagentMessages">>,
  sessionId: string,
  resolvedDir: string | undefined,
  perSubagentLimit: number,
  mainMessages: readonly SDKSessionMessage[],
): Promise<SessionMessage[]> {
  let subagentIds: string[];
  try {
    subagentIds = await sdk.listSubagents(
      sessionId,
      resolvedDir !== undefined ? { dir: resolvedDir } : undefined,
    );
  } catch {
    return [];
  }

  const eligibleIds = subagentIds
    .filter((id) => typeof id === "string" && id !== "" && !isHousekeepingSubagentId(id))
    .slice(0, MAX_SUBAGENTS_PER_SESSION);
  if (eligibleIds.length === 0) return [];

  const agentIdToToolUseId = extractAgentIdToToolUseIdMap(mainMessages);
  const batches = await Promise.all(
    eligibleIds.map(async (agentId) => {
      try {
        const subMsgs = await sdk.getSubagentMessages(sessionId, agentId, {
          ...(resolvedDir !== undefined ? { dir: resolvedDir } : {}),
          limit: perSubagentLimit,
        });
        const parentToolUseId = agentIdToToolUseId.get(agentId);
        return subMsgs.map((subMsg) =>
          toSessionMessage(subMsg, {
            agentId,
            ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
          }),
        );
      } catch {
        return [];
      }
    }),
  );

  return batches.flat();
}
