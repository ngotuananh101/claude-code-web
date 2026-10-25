/**
 * Normalization of SDK `stream_event` frames into app protocol events (§12.3).
 *
 * The SDK delivers the raw Anthropic streaming frames behind every complete
 * message when `includePartialMessages` is on. The durable transcript stays
 * complete-message based — these frames become exactly two event types, keyed
 * by the SDK message id so the browser can accumulate them into the message
 * `message.completed` will finalize:
 *
 *   message.started { messageId }        — from `message_start`
 *   message.delta   { messageId, text }  — from each `text_delta` fragment
 *   tool.started    { toolCallId, toolName } — from a `tool_use` block start
 *
 * Everything else the raw stream carries stays here: thinking deltas (internal
 * reasoning, §12.3), tool-input fragments (parsed only when complete), block
 * bookkeeping, and any frame too malformed to trust. One normalizer per run —
 * the closure is the correlation state, and chains (`parent_tool_use_id`) keep
 * separate current ids so a subagent's stream cannot bleed into the main one.
 */

export type NormalizedStreamEvent = {
  type: "message.started" | "message.delta" | "tool.started";
  payload: Record<string, unknown>;
};

export function createStreamNormalizer(): (
  sdkMessage: Record<string, unknown>,
) => NormalizedStreamEvent[] {
  const currentId = new Map<string, string>();

  return (sdkMessage: Record<string, unknown>): NormalizedStreamEvent[] => {
    if (sdkMessage["type"] !== "stream_event") return [];
    const parentKey = String(sdkMessage["parent_tool_use_id"] ?? "");
    const event = sdkMessage["event"];
    if (typeof event !== "object" || event === null) return [];
    const raw = event as Record<string, unknown>;

    if (raw["type"] === "message_start") {
      const message = raw["message"];
      const id =
        typeof message === "object" && message !== null
          ? (message as Record<string, unknown>)["id"]
          : undefined;
      if (typeof id !== "string" || id === "") return [];
      currentId.set(parentKey, id);
      return [{ type: "message.started", payload: { messageId: id } }];
    }

    if (raw["type"] === "content_block_start") {
      // A tool_use block start is the SDK's evidence a tool call is being
      // made — id and name are final, the input streams later as fragments
      // and is never echoed (§12.3: input is parsed only when complete, and
      // this event is not where it would live). Tool ids are globally unique
      // across chains, so no currentId correlation is needed.
      const block = raw["content_block"];
      if (typeof block !== "object" || block === null) return [];
      const toolUse = block as Record<string, unknown>;
      if (toolUse["type"] !== "tool_use") return [];
      const toolCallId = toolUse["id"];
      const toolName = toolUse["name"];
      if (typeof toolCallId !== "string" || toolCallId === "") return [];
      if (typeof toolName !== "string" || toolName === "") return [];
      return [{ type: "tool.started", payload: { toolCallId, toolName } }];
    }

    if (raw["type"] === "content_block_delta") {
      const delta = raw["delta"];
      if (typeof delta !== "object" || delta === null) return [];
      const fragment = delta as Record<string, unknown>;
      if (fragment["type"] !== "text_delta") return [];
      const text = fragment["text"];
      const id = currentId.get(parentKey);
      if (typeof text !== "string" || id === undefined) return [];
      return [{ type: "message.delta", payload: { messageId: id, text } }];
    }

    return [];
  };
}
