/**
 * Pure helpers for replaying a resumed session's historical messages into the
 * journal (§16.1, Task 13).
 *
 * A resumed Claude Code session preloads its past `SessionMessage`s from the
 * runner (the messages shape the runner returns for a `workspace.sessions.messages`
 * command), and `EventJournal.vue` renders them chronologically above the live
 * run events. The `.vue` SFC cannot be compiled in the Bun test environment
 * (no `@vue/compiler-sfc`), so the extraction this component relies on lives
 * here as pure, unit-testable functions — the same convention the codebase uses
 * for `streaming-messages.ts` and `markdown.ts`.
 *
 * Message text extraction must be tolerant: the wire type is `message: unknown`,
 * and the runner surfaces whatever the Claude Code SDK persisted. We handle the
 * documented shapes (string content, and the Anthropic-style content block
 * array) and degrade to a safe fallback rather than throwing — a single
 * malformed historical message must not blank the whole replayed header.
 */

import type { SessionMessage } from "@cc-web/protocol";

/**
 * A single historical message rendered above the live transcript.
 *
 * `text` is the extracted prose (already markdown-safe — the template runs it
 * through `renderMarkdown` from `markdown.ts`). `rendered` is a pre-computed
 * fallback for non-prose content: when `text` is empty the row shows the raw
 * message JSON so an unexpected shape stays visible (mirrors the live-event
 * `pre ... JSON.stringify` fallback in `EventJournal.vue`).
 */
export type HistoryRow = {
  key: string;
  uuid: string;
  type: "user" | "assistant" | "system";
  /** Extracted prose (markdown source); "" when the shape was not extractable. */
  text: string;
  /** Raw JSON fallback, only used when `text` is empty. */
  rendered: string;
};

/**
 * Pull the readable text out of one `SessionMessage`.
 *
 * - assistant/system messages are the Anthropic shape with a `content` that is
 *   either a string or an array of `{ type: "text", text }` blocks (the runner
 *   redacts `tool_use` blocks, but we skip non-text blocks defensively).
 * - user messages may carry the same content-block shape, or a plain string
 *   under `content` (`{ content: "hello" }`), as the sessions-api test fixture
 *   shows.
 * - Anything that does not match yields "" — the caller then falls back to
 *   the raw JSON so the message never silently disappears.
 */
export function messageTextOf(message: SessionMessage): string {
  const msg = message.message as Record<string, unknown> | null | undefined;
  if (msg === null || typeof msg !== "object") return "";

  const content = msg["content"];

  // Anthropic-style content block array: take only text blocks.
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const record = block as Record<string, unknown>;
      if (record["type"] !== "text") continue;
      if (typeof record["text"] === "string" && record["text"] !== "") texts.push(record["text"]);
    }
    if (texts.length > 0) return texts.join("\n\n");
    return "";
  }

  // Plain string content (`{ content: "hello" }`).
  if (typeof content === "string") return content;

  return "";
}

/**
 * Convert a session's preloaded historical messages into journal rows.
 *
 * Order is preserved as received (the runner returns them chronologically); the
 * caller is responsible for feeding them in transit order. The result is pure
 * input → output, so a replayed header is identical across subscribes and
 * re-renders.
 */
export function deriveHistoryRows(messages: readonly SessionMessage[]): HistoryRow[] {
  return messages.map((message) => {
    const text = messageTextOf(message);
    const rendered = text === "" ? JSON.stringify(message.message ?? null, null, 2) : "";
    return {
      key: `history-${message.uuid}`,
      uuid: message.uuid,
      type: message.type,
      text,
      rendered,
    };
  });
}

/**
 * Whether a history row has prose worth rendering as markdown. When false the
 * template renders the JSON fallback instead (mirrors the live-event rows).
 */
export function hasProse(row: HistoryRow): boolean {
  return row.text !== "";
}
