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
import { redactErrorText } from "../execution/redact.ts";

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

        const mapped: SessionMessage[] = messages.map(toSessionMessage);
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
  const sdk = require("@anthropic-ai/claude-agent-sdk") as {
    listSessions: SessionsSdk["listSessions"];
    getSessionMessages: SessionsSdk["getSessionMessages"];
  };
  return sdk;
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

function toSessionMessage(msg: SDKSessionMessage): SessionMessage {
  return {
    type: msg.type,
    uuid: msg.uuid,
    message: msg.message,
  };
}
