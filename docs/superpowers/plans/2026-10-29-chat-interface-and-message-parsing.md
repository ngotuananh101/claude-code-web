# Chat Interface & Message Parsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the raw table/JSON event journal into an interactive, chat-bubble interface (user messages on right, agent turns on left with process timeline, collapsible thinking/tool steps, diff badges, markdown prose, and an advanced raw-payload toggle).

**Architecture:** A pure, deterministic parsing layer in `apps/web/src/features/journal/chat-turns.ts` transforms both historical `SessionMessage[]` and streaming `BrowserReplayEvent[]` into structured `ChatTurn` objects (`UserTurn` vs `AgentTurn`). A dedicated suite of Vue components in `apps/web/src/components/chat/` renders user bubbles on the right and unified agent turns on the left, displaying execution duration headers ("Worked for X"), timeline steps (`ThinkingStep`, `ToolStep` with Terminal/Edit/Write/Explore icons, diff badges, and collapsible output), approval gates, markdown assistant prose, and a collapsible raw JSON inspector.

**Tech Stack:** Vue 3, TypeScript, Tailwind CSS v4, Lucide Vue icons, markdown-it, Bun test.

**Spec:** Inspired by `jetbrains-cc-gui` and User Design Mockup (Image #3); adhering to `docs/ARCHITECTURE.md` §12.3 (redaction & assistant prose), §16.1 (session messages replay), and CLAUDE.md guidelines (no editing generated `ui/**`, Vietnamese user-facing copy, English code/tests).

## Global Constraints

- **Never edit shadcn-vue generated files:** `apps/web/src/components/ui/**`, `apps/web/src/lib/utils.ts`, `apps/web/src/styles/index.css`, `apps/web/components.json` are untouchable. Use Tailwind utility classes and component wrappers.
- **Language conventions:** All user-facing UI labels, toasts, and tooltips in Vietnamese; all code, identifiers, tests, and comments in English.
- **XSS safety:** All markdown and HTML rendering must continue using `renderMarkdown` from `markdown.ts` with `html: false` and link scheme validation.
- **Testing environment:** Bun test cannot compile `.vue` SFCs. All data transformation, parsing, duration formatting, and grouping logic must reside in pure TypeScript modules in `features/journal/` with 100% test coverage.
- **Deterministic replay:** Live streaming events and historical replayed messages must produce identical turn structures and avoid duplicate keys or flicker.

## Review Focus

1. **Tool use and tool result pairing:** In historical transcripts, tool inputs appear in `assistant.content[type="tool_use"]` while tool outputs and error flags appear in `user.content[type="tool_result"]` (linked by `tool_use_id`). The parser must pair them without leaking tool results as user chat bubbles.
2. **Prompt cleanup:** User turns must filter out internal command tags (`<command-message>`, `<command-name>`, attachments metadata) so the user bubble shows clean natural prose.
3. **Collapsible state preservation:** Toggling thinking blocks, tool outputs, or the raw JSON view must not reset when new streaming deltas arrive.
4. **File diff stats:** File edit tools (`Edit`, `Write`) must extract file paths, diff statistics (e.g. lines added/removed), and error statuses for clear visual badges.
5. **Streaming responsiveness:** As streaming deltas arrive, the current agent turn must display active progress indicators ("Đang suy nghĩ...", "Đang chạy...") and live prose without layout thrashing.

---

### Task 1: Pure Chat Parser & Data Model (`chat-turns.ts`)

**Files:**
- Create: `apps/web/src/features/journal/chat-turns.ts`
- Test: `apps/web/src/features/journal/chat-turns.test.ts`

**Interfaces:**
- Produces:
  - `type ChatTurn = UserTurn | AgentTurn`
  - `type UserTurn = { kind: "user"; key: string; uuid?: string; text: string; rawPayload?: unknown }`
  - `type AgentStep = ThinkingStep | ToolStep | ApprovalStep`
  - `type ThinkingStep = { kind: "thinking"; key: string; text: string; durationMs?: number }`
  - `type ToolStep = { kind: "tool"; key: string; toolCallId: string; toolName: string; state: "running" | "done" | "error" | "interrupted"; inputSummary?: string | null; outputSummary?: string | null; filePath?: string; command?: string; diffStats?: { added: number; removed: number }; rawPayload?: unknown }`
  - `type ApprovalStep = { kind: "approval"; key: string; event: BrowserReplayEvent }`
  - `type AgentTurn = { kind: "agent"; key: string; runId?: string; status: "running" | "done" | "error" | "interrupted"; durationText?: string; steps: AgentStep[]; text: string; isStreaming?: boolean; rawPayload?: unknown }`
  - `deriveChatTurns(historicalMessages: readonly SessionMessage[], liveEvents: readonly BrowserReplayEvent[]): ChatTurn[]`
  - `formatDuration(ms: number): string` (e.g. "12m 50s", "3s", "< 1s")
  - `cleanUserPrompt(rawText: string): string`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/features/journal/chat-turns.test.ts` covering:
- Parsing plain string user prompt into a `UserTurn` (and cleaning `<command-message>` wrappers).
- Parsing assistant message with `thinking` block into `AgentTurn` with a `ThinkingStep`.
- Parsing assistant message with `tool_use` (Bash, Edit, Write, Read) and matching `tool_result` into a `ToolStep`.
- Verifying file path and command extraction from tool inputs.
- Verifying diff calculation for `Edit` input (counting added/removed lines).
- Parsing live `BrowserReplayEvent[]` (`run.started`, `message.delta`, `tool.started`, `tool.completed`, `run.finished`).
- Merging historical messages and live events into seamless chronological turns.
- Verifying `formatDuration(ms)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/features/journal/chat-turns.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `chat-turns.ts`**

Implement pure functions:
- `cleanUserPrompt(text)`: strips `<command-message>`, `<command-name>`, and extracts human prompt.
- `extractDiffStats(toolName, input)`: calculates added and removed lines for `Edit` (from `old_string` / `new_string`).
- `formatDuration(ms)`: formats milliseconds into Vietnamese/standard duration strings ("12m 50s", "4s").
- `deriveChatTurns(historicalMessages, liveEvents)`: builds `ChatTurn[]` state machine, pairing tool use with tool results, collecting thinking steps, and appending live streaming deltas.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/features/journal/chat-turns.test.ts`
Expected: PASS with 100% assertions green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/journal/chat-turns.ts apps/web/src/features/journal/chat-turns.test.ts
git commit -m "feat(web): add pure chat parser and turn model"
```

---

### Task 2: Chat Step Components (`UserChatBubble`, `AgentThinkingStep`, `AgentToolStep`)

**Files:**
- Create: `apps/web/src/components/chat/UserChatBubble.vue`
- Create: `apps/web/src/components/chat/AgentThinkingStep.vue`
- Create: `apps/web/src/components/chat/AgentToolStep.vue`

**Interfaces:**
- Consumes: `UserTurn`, `ThinkingStep`, `ToolStep` from `chat-turns.ts`, `renderMarkdown` from `markdown.ts`.
- Produces: UI components for chat rendering.

- [ ] **Step 1: Implement `UserChatBubble.vue`**
  - Renders user prompt right-aligned (`flex justify-end`).
  - Container: `max-w-[85%] rounded-2xl bg-secondary/80 border border-border px-4 py-2.5 text-[13px] text-foreground shadow-xs`.
  - Markdown rendered user prose via `renderMarkdown`.
  - Optional raw JSON trigger on hover.

- [ ] **Step 2: Implement `AgentThinkingStep.vue`**
  - Collapsible timeline item with `{ }` thought icon.
  - Header: "Suy nghĩ · {{ durationText }}" with Chevron toggle.
  - Collapsible body: formatted thinking block in monospace/muted box with subtle border.

- [ ] **Step 3: Implement `AgentToolStep.vue`**
  - Timeline row with icon based on tool:
    - Terminal icon for `Bash` / `Terminal`.
    - FileEdit icon for `Edit`.
    - FilePlus icon for `Write`.
    - FileText icon for `Read`.
    - Search icon for `Grep` / `Glob` / explore.
  - Title & Badges:
    - Tool name + path or command.
    - Status badge: `[Thất bại]` in red (`text-destructive bg-destructive/10`) or green check on success, spinner on running.
    - Diff badge for edits: `+X` in emerald, `-Y` in rose.
  - Collapsible drawer: click toggles expanded input summary and output summary with monospace formatting and copy button.

- [ ] **Step 4: Verify typecheck & build**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/UserChatBubble.vue apps/web/src/components/chat/AgentThinkingStep.vue apps/web/src/components/chat/AgentToolStep.vue
git commit -m "feat(web): add chat bubble and agent timeline step components"
```

---

### Task 3: Unified Agent Turn & Raw Payload Inspector (`AgentChatTurn.vue`)

**Files:**
- Create: `apps/web/src/components/chat/AgentChatTurn.vue`

**Interfaces:**
- Consumes: `AgentTurn` from `chat-turns.ts`, `AgentThinkingStep`, `AgentToolStep`, `ApprovalCard`, `renderMarkdown`.
- Produces: Complete agent turn presentation.

- [ ] **Step 1: Implement `AgentChatTurn.vue`**
  - Left-aligned container: `flex flex-col gap-3 max-w-full`.
  - **Turn Header**:
    - "Worked for {{ durationText }}" or "Đang suy nghĩ / xử lý…" with clock icon and horizontal divider.
  - **Process Timeline**:
    - Border-l container for chronological steps (`AgentThinkingStep`, `AgentToolStep`, `ApprovalCard`).
  - **Assistant Response**:
    - Final markdown response rendered with `renderMarkdown` and `proseClasses`.
    - If streaming without final message, pulse indicator.
  - **Raw Payload Toggle (Advanced Feature)**:
    - Subtle button at bottom: `Xem JSON gốc` (`{ }` icon).
    - When clicked, opens collapsible `<pre class="text-xs bg-muted p-3 rounded-md overflow-x-auto">` showing formatted raw JSON for debugging.

- [ ] **Step 2: Verify typecheck & build**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/chat/AgentChatTurn.vue
git commit -m "feat(web): add AgentChatTurn with timeline and raw payload toggle"
```

---

### Task 4: Integrate Chat Interface into `EventJournal.vue`

**Files:**
- Modify: `apps/web/src/components/EventJournal.vue`

**Interfaces:**
- Consumes: `deriveChatTurns` from `chat-turns.ts`, `UserChatBubble`, `AgentChatTurn`.

- [ ] **Step 1: Refactor `EventJournal.vue`**
  - Replace raw table/grid layout with chat feed:
    - Compute `turns = computed(() => deriveChatTurns(props.historicalMessages ?? [], props.events))`
    - Loop over `turns`:
      - If `turn.kind === 'user'`: render `<UserChatBubble :turn="turn" />`
      - If `turn.kind === 'agent'`: render `<AgentChatTurn :turn="turn" />`
  - Maintain resync banner, empty state notice, and auto-scroll behavior.

- [ ] **Step 2: Run all tests and checks**

Run: `bun test apps/web`
Run: `bun run typecheck`
Run: `cd apps/web && bun run build`

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/EventJournal.vue
git commit -m "feat(web): connect chat turns interface to EventJournal"
```

---

### Task 5: End-to-End Verification, Linter & Documentation

**Files:**
- Modify: `apps/web/src/features/journal/index.ts` (if barrel exports exist)
- Test: Full integration test suite

- [ ] **Step 1: Run full gate checks**

Run: `bun test`
Run: `bun run typecheck`
Run: `bunx biome check apps/web`
Run: `cd apps/web && bun run build`

- [ ] **Step 2: Fix any linter or formatting issues**

Run: `bunx biome check --write apps/web`

- [ ] **Step 3: Commit & Push**

```bash
git commit -am "chore(web): finalize chat interface formatting and exports"
git push origin main
```
