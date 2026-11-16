import type { SessionMessage } from "@cc-web/protocol";
import { cleanChatPrompt } from "@cc-web/shared";

/** Page complete main-chat bubbles, not raw SDK rows or child transcripts. */
export function createSdkChatPages(messages: SessionMessage[]) {
  const starts: number[] = [];
  let agent = false;
  for (let index = 0; index < messages.length; index++) {
    const row = messages[index]!;
    if (row.parentToolUseId || row.agentId || row.type === "system") continue;
    if (row.type === "user") {
      const message = row.message as { content?: unknown } | null;
      const content = message?.content;
      const prose =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((block) => block?.type === "text")
                .map((block) => block.text ?? "")
                .join("\n")
            : "";
      if (prose.includes("<task-notification") || prose.includes("<task-id>")) agent = false;
      if (cleanChatPrompt(prose) === "") continue;
      starts.push(index);
      agent = false;
    } else if (!agent) {
      starts.push(index);
      agent = true;
    }
  }
  return (before: number) => {
    // Binary search makes continuation independent of the unrequested prefix size.
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (starts[mid]! < before) low = mid + 1;
      else high = mid;
    }
    if (before !== Number.MAX_SAFE_INTEGER && starts[low] !== before) return undefined;
    const start = starts[Math.max(0, low - 12)];
    return {
      messages:
        low === 0 || start === undefined
          ? []
          : messages
              .slice(start, Math.min(before, messages.length))
              .filter((row) => !row.parentToolUseId && !row.agentId),
      chatBefore: low === 0 ? null : (start ?? null),
      hasMore: low > 12,
    };
  };
}
