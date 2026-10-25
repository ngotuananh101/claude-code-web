import MarkdownIt from "markdown-it";

/**
 * Prose rendering for the journal (§12.3, master roadmap M1).
 *
 * The output of `renderMarkdown` reaches `v-html`, so the renderer's
 * configuration IS the security boundary and must not be loosened:
 *
 *  - `html: false` — every raw HTML tag in the source text arrives escaped,
 *    so `<script>` or `<img onerror=…>` can never become live markup.
 *  - markdown-it's own link validation rejects `javascript:`, `vbscript:`,
 *    `file:` and non-image `data:` URLs, so a crafted link cannot smuggle an
 *    executable href past the escaping.
 *  - `linkify`/`typographer` stay off: no surprising rewrites of the text the
 *    model actually produced.
 *
 * Assistant text itself is not secret-masked (the streaming milestone's
 * ruling: model output the user asked for is not a leak) — escaping is the
 * only transformation the markdown path adds.
 */
const md = new MarkdownIt({ html: false, linkify: false, breaks: false, typographer: false });

// The journal re-renders on every streamed batch, and each render calls this
// for every prose row — without a cache that is a full markdown re-parse of
// the whole transcript per update (review #4). Keyed by the exact input, so
// the output is the same either way; the size cap keeps a long session's
// cumulative streaming strings from growing the map without bound.
const renderCache = new Map<string, string>();
const RENDER_CACHE_MAX = 400;

export function renderMarkdown(text: string): string {
  if (text.trim() === "") return "";
  const cached = renderCache.get(text);
  if (cached !== undefined) return cached;
  const html = md.render(text);
  if (renderCache.size >= RENDER_CACHE_MAX) renderCache.clear();
  renderCache.set(text, html);
  return html;
}

/**
 * The prose inside a `message.completed` payload: the executor persists the
 * redacted SDKAssistantMessage, whose text blocks are what an operator reads.
 * `tool_use` blocks are skipped — the tool rows already represent each call —
 * and any shape that does not match yields "", which the template turns into
 * the raw-JSON fallback rather than a blank row.
 */
export function assistantTextOf(payload: unknown): string {
  const message = (payload as Record<string, unknown> | null)?.["message"];
  if (typeof message !== "object" || message === null) return "";
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record["type"] !== "text") continue;
    if (typeof record["text"] === "string" && record["text"] !== "") texts.push(record["text"]);
  }
  return texts.join("\n\n");
}

/**
 * One class list for every prose surface (streaming bubble, completed
 * message). Arbitrary variants instead of a typography plugin or scoped CSS:
 * v-html content cannot carry scoped attributes, and styles/index.css is the
 * owner's file. Inline code gets a muted chip; code inside a fenced block
 * resets it so chips never nest.
 */
export const proseClasses =
  "text-sm leading-relaxed [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 " +
  "[&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2.5 " +
  "[&_pre]:font-mono [&_pre]:text-[12.5px] [&_pre_code]:bg-transparent [&_pre_code]:p-0 " +
  "[&_pre_code]:text-inherit [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 " +
  "[&_code]:font-mono [&_code]:text-[12.5px] [&_a]:text-primary [&_a]:underline " +
  "[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 " +
  "[&_li]:my-0.5 [&_h1]:mt-3 [&_h1]:mb-1.5 [&_h1]:text-base [&_h1]:font-semibold " +
  "[&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:font-semibold [&_h3]:mt-2.5 [&_h3]:mb-1 [&_h3]:font-medium " +
  "[&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-border " +
  "[&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground " +
  "[&_table]:my-1.5 [&_table]:w-full [&_table]:text-left [&_th]:px-2 [&_th]:py-1 " +
  "[&_th]:font-medium [&_td]:px-2 [&_td]:py-1";
