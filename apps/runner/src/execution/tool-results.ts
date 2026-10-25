import { summarizeToolInput } from "./redact.ts";

/**
 * Mapping of complete `user` frames into `tool.completed` events (§12.3, §12.4).
 *
 * The SDK's evidence that a tool ran and returned is the `tool_result` block
 * the CLI sends back as a user message — the same frames that today land in
 * the outbox as generic `run.status` JSON blobs. A frame whose content is
 * entirely tool_result blocks is replaced by one `tool.completed` per block;
 * anything else (model text, mixed blocks, an echo of the prompt) keeps its
 * existing path, so an unexpected shape stays visible instead of being
 * silently half-mapped.
 *
 * The result content never leaves as-is: the journal carries the same
 * secret-masked, size-capped summary the approval flow uses (§13, §19.4) —
 * `summarizeToolInput`.
 */

export type ToolCompletion = {
  toolCallId: string;
  isError: boolean;
  outputSummary?: string;
};

function contentBlocks(message: Record<string, unknown>): unknown[] | null {
  const messageField = message["message"];
  if (typeof messageField !== "object" || messageField === null) return null;
  const content = (messageField as Record<string, unknown>)["content"];
  if (!Array.isArray(content) || content.length === 0) return null;
  return content as unknown[];
}

function isToolResultBlock(block: unknown): block is Record<string, unknown> {
  if (typeof block !== "object" || block === null) return false;
  const record = block as Record<string, unknown>;
  if (record["type"] !== "tool_result") return false;
  return typeof record["tool_use_id"] === "string" && record["tool_use_id"] !== "";
}

export function isToolResultFrame(message: Record<string, unknown>): boolean {
  if (message["type"] !== "user") return false;
  const blocks = contentBlocks(message);
  if (blocks === null) return false;
  return blocks.every(isToolResultBlock);
}

/** The flattening a summary needs: a bare string as-is, text blocks joined. */
function flattenText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record["type"] !== "text") continue;
    if (typeof record["text"] === "string") texts.push(record["text"]);
  }
  return texts.join("\n");
}

export function toolCompletionsOf(message: Record<string, unknown>): ToolCompletion[] {
  const blocks = contentBlocks(message);
  if (blocks === null) return [];
  const completions: ToolCompletion[] = [];
  for (const block of blocks) {
    if (!isToolResultBlock(block)) continue;
    const summary = summarizeToolInput(flattenText(block["content"]));
    const completion: ToolCompletion = {
      toolCallId: block["tool_use_id"] as string,
      isError: block["is_error"] === true,
      ...(summary === "" ? {} : { outputSummary: summary }),
    };
    completions.push(completion);
  }
  return completions;
}
