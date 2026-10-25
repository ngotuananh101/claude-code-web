# M1 — Journal Readability (markdown + assistant prose) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assistant text renders as sanitized markdown in the journal — the streaming bubble and the `message.completed` row both show prose instead of a raw `pre` and a `JSON.stringify` blob.

**Architecture:** One pure, unit-testable module owns rendering: `renderMarkdown(text)` (markdown-it, `html: false` — raw HTML is escaped and `javascript:`-style URLs are rejected by the renderer's own link validation, so the output is safe for `v-html`) and `assistantTextOf(payload)` (extracts the text blocks from the redacted `SDKAssistantMessage` shape the executor persists, skipping `tool_use` blocks that the tool rows already represent). EventJournal calls both from template branches; prose styling is Tailwind arbitrary variants on a shared class constant (no scoped CSS, no typography plugin, `styles/index.css` untouched — the owner's file).

**Tech Stack:** Vue 3, markdown-it 15 (bundled types, caret range), Tailwind v4 arbitrary variants, bun test.

**Spec:** `docs/superpowers/plans/2026-10-26-master-roadmap.md` (M1), `docs/ARCHITECTURE.md` §12.3 (redaction policy — assistant text is model output the user asked for, not a leak), §19.4 (no credential exposure; rendering is client-side only).

## Global Constraints

- The rendered string reaches `v-html` — XSS safety is a hard requirement pinned by tests: raw HTML in the source text must arrive escaped; `javascript:`/`vbscript:`/`data:` (non-image) URLs must not survive as hrefs. markdown-it runs with `html: false`, `linkify: false`, `breaks: false`, `typographer: false` — one shared instance.
- Assistant text is not secret-masked (§12.3 ruling from the streaming milestone): the payload is already redacted where redaction applies; rendering must not add its own filtering beyond HTML escaping.
- `message.completed` rows with any other shape (missing `message.content`, no text blocks) fall back to today's raw JSON view — an unexpected shape stays visible, never a blank row.
- bun test cannot compile SFCs: all behavior lives in the pure module; the template is verified by the web build.
- Tailwind utilities only; generated `ui/**` never edited; VN copy for any new labels; tests/comments in English; TDD RED→GREEN.

## Review Focus

1. Raw HTML in streamed/completed text (`<script>alert(1)</script>`, `<img onerror=…>`) arrives escaped — pinned in Task 1.
2. A markdown link with a `javascript:` (and `data:text/html`) URL does not survive as an href — pinned in Task 1.
3. Empty or whitespace-only text renders an empty string (no ghost markup, no empty bordered block) — pinned in Task 1.
4. A `message.completed` payload whose `message.content` has no text blocks yields `""` from `assistantTextOf` so the template falls back to raw JSON — pinned in Task 1.
5. Code inside a fenced block must not pick up the inline-code chip styling (nested selector reset) — build-verified styling, class constant reviewed in Task 2.

---

### Task 1: The rendering module (web, pure)

**Files:**
- Create: `apps/web/src/features/journal/markdown.ts`
- Test: `apps/web/src/features/journal/markdown.test.ts`

**Interfaces:**
- Produces (Task 2 consumes):
  - `renderMarkdown(text: string): string` — safe HTML fragment; `""` for `""`/whitespace-only input.
  - `assistantTextOf(payload: unknown): string` — for the executor's redacted `SDKAssistantMessage` shape `{ type: "assistant", message: { content: Array<{ type: "text"; text: string } | …> } }`, the `text` blocks joined with `"\n\n"`; `""` when the shape does not match or no text blocks exist.

- [ ] **Step 1: Write the failing tests** — `markdown.test.ts` covering: bold/italic render; a fenced code block renders `<pre><code>`; a paragraph with `\n\n` splits; `<script>alert(1)</script>` arrives with `&lt;script&gt;` (and no live tag); `<img src=x onerror=alert(1)>` likewise escaped; `[x](javascript:alert(1))` produces no `javascript:` href (rendered as text or stripped); `[x](data:text/html,…)` same; a normal `[x](https://a.b)` link keeps its href; empty string and `"   \n"` → `""`; `assistantTextOf`: two text blocks joined `\n\n`; `tool_use` blocks skipped; missing `message`/non-array content/`null` payload → `""`; `renderMarkdown` output of the extracted text contains the joined prose.
- [ ] **Step 2: Run to verify RED** — module missing.
- [ ] **Step 3: Implement** — one module-level `MarkdownIt` instance with the frozen options; `renderMarkdown` trims and returns `""` for blank input; `assistantTextOf` walks `payload.message.content` defensively (typeof checks at every hop).
- [ ] **Step 4: Run to GREEN** — `bun test apps/web/src/features/journal/markdown.test.ts`, then `bun test apps/web`.
- [ ] **Step 5: Commit** — `git commit -m "feat: render assistant text as sanitized markdown"`.

### Task 2: EventJournal prose (web UI)

**Files:**
- Modify: `apps/web/src/components/EventJournal.vue`

**Interfaces:**
- Consumes: `renderMarkdown`, `assistantTextOf` (Task 1); the existing streaming row and `message.completed` event row.

Changes: the streaming bubble's `<pre>{{ row.text }}</pre>` becomes `<div :class="proseClasses" v-html="renderMarkdown(row.text)">` (interrupted styling stays via the wrapper's text color). The `message.completed` event row gets a branch before the generic JSON `pre`: when `assistantTextOf(row.event.payload)` is non-empty, render it through `renderMarkdown` in the same prose wrapper; otherwise the existing JSON `pre` unchanged. Export a `proseClasses` constant from the markdown module (single source for both call sites) with arbitrary variants for `p/pre/code/pre code/a/ul/ol/h1-h4/blockquote/table` — inline code gets a muted chip, fenced code resets it (`[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit`), fenced blocks scroll horizontally.

- [ ] **Step 1: Implement** the two template branches + import; keep every other row kind untouched.
- [ ] **Step 2: Verify** — `cd apps/web && bun run build` and `bunx biome check .` at the repo root; `bun test apps/web` still green.
- [ ] **Step 3: Commit** — `git commit -m "feat: render journal messages as prose"`.

### Task 3: Full gates + push

- [ ] **Step 1: Gates** — `bun test`, `bun run typecheck`, `bunx biome check .`, web build (runner untouched; the integration chain is unaffected — note that in the ledger).
- [ ] **Step 2: Push** to `main`, then whole-branch review per the standing protocol (this is milestone M1 of the master roadmap — review ranges from the roadmap commit to the last M1 commit).

## Non-goals

- Markdown in tool summaries (plain `pre` stays — summaries are one-liners).
- Thinking-block rendering (never persisted), diff syntax highlighting, copy buttons, heading anchors.
- Any change to what the runner persists (rendering-only milestone; payload hygiene is M2).
