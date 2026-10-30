# Chat Loading, Process Accordion, and Persistent Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize chat performance and user experience by (1) collapsing agent execution steps into a modern process accordion (like Claude.ai / ChatGPT), (2) eliminating approval request timeouts so permissions never expire while waiting, and (3) implementing reverse pagination with scroll anchoring in the chat journal.

**Architecture:**
- **Execution Accordion (`AgentChatTurn.vue`)**: Group consecutive thinking steps and tool calls into a unified collapsible container. While running, show dynamic spinner and the latest active step name; when finished, collapse into a single summary line (`✓ X bước thực hiện · Ys`). Pending approvals always remain elevated and visible outside the collapsed container.
- **Persistent Approvals (`executor.ts`, `approvals.ts`, `ApprovalCard.vue`)**: Disable the default 5-minute timeout on tool approvals and user questions by allowing infinite timeout (`timeoutMs <= 0` or omitted), bypassing timeout scheduling so decisions remain answerable until explicit user action or run abort.
- **Reverse Pagination & Scroll Anchoring (`EventJournal.vue`, `scroll.ts`)**: Render only the newest 20 turns on initial session mount. When the user scrolls near the top or clicks "Tải thêm tin nhắn cũ", prepend earlier turns and apply scroll anchoring (`scrollTop += deltaHeight`) to prevent any viewport jumping.

**Tech Stack:** Vue 3 (Composition API, `<script setup>`), TypeScript, Tailwind CSS, Lucide icons, Bun, Bun test runner.

---

## Global Constraints

- Never edit, format, or lint shadcn-vue generated files (`apps/web/src/components/ui/**`, `apps/web/src/lib/utils.ts`, `apps/web/src/styles/index.css`, `apps/web/components.json`).
- Always write all code, identifiers, commit messages, and comments in English.
- All user-facing UI labels must be in Vietnamese.
- All tests must pass with `/home/anhnt/.ponta/apps/bun/1.4.3/bun test`.
- TypeScript (`bun run typecheck`) and Biome (`bun run lint`) must remain clean.

## Review Focus

1. **Scroll jump when expanding turns**: Expanding/collapsing the process accordion while near the bottom must preserve smooth auto-scroll.
2. **Pending approval visibility**: A run that pauses on an approval must NEVER hide that approval inside a collapsed accordion.
3. **Scroll anchoring precision**: Loading earlier turns while reading near the top must maintain exact reading position without flickering.
4. **Resumed/replayed runs**: Replaying old sessions must correctly compute step counts and duration in the collapsed badge.
5. **No approval leaks**: If a run is aborted or interrupted while an approval is pending, callbacks must cleanly unwind and release resources.

---

### Task 1: Persistent Approvals (Remove Approval Timeout)

**Files:**
- Modify: `apps/runner/src/execution/executor.ts:178-185`
- Modify: `apps/runner/src/execution/approvals.ts:110-153`
- Modify: `apps/runner/src/execution/approvals.test.ts`
- Modify: `apps/web/src/components/ApprovalCard.vue:85-95`

**Interfaces:**
- `approvals.ts`: Support `timeoutMs <= 0` or `timeoutMs === undefined` as infinite timeout (`expiresAt = Number.MAX_SAFE_INTEGER`, no timer scheduled).
- `executor.ts`: `approvalTimeoutMs()` defaults to `0` (disabled) unless explicitly configured with positive `CC_WEB_APPROVAL_TIMEOUT_MS`.

- [ ] **Step 1: Write unit tests for infinite approval timeout in `apps/runner/src/execution/approvals.test.ts`**

Add tests:
- `test("a timeoutMs of 0 sets MAX_SAFE_INTEGER expiry and schedules no timeout timer")`
- `test("remains answerable without expiring when timeoutMs is 0")`

- [ ] **Step 2: Run test to verify it fails**

Run: `/home/anhnt/.ponta/apps/bun/1.4.3/bun test apps/runner/src/execution/approvals.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Update `approvals.ts` and `executor.ts`**

In `approvals.ts`:
- Check if `input.timeoutMs && input.timeoutMs > 0`. If false or 0, set `expiresAt = Number.MAX_SAFE_INTEGER` and do NOT schedule `sweepExpired()` timer (cancelTimer is no-op).
In `executor.ts`:
- Update `approvalTimeoutMs()`: return 0 (infinite) by default unless `Bun.env["CC_WEB_APPROVAL_TIMEOUT_MS"]` is a positive number.
In `ApprovalCard.vue`:
- Treat `expiresAt === undefined || expiresAt >= Number.MAX_SAFE_INTEGER - 10000` as non-expiring.

- [ ] **Step 4: Run approvals tests to verify they pass**

Run: `/home/anhnt/.ponta/apps/bun/1.4.3/bun test apps/runner/src/execution/approvals.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/execution/approvals.ts apps/runner/src/execution/executor.ts apps/runner/src/execution/approvals.test.ts apps/web/src/components/ApprovalCard.vue
git commit -m "fix(approvals): remove automatic approval timeout so permissions wait indefinitely"
```

---

### Task 2: Process Accordion for Thinking and Tool Calls

**Files:**
- Create: `apps/web/src/components/chat/AgentProcessAccordion.vue`
- Modify: `apps/web/src/components/chat/AgentChatTurn.vue`
- Test: `apps/web/src/features/journal/chat-turns.test.ts`

**Interfaces:**
- `AgentProcessAccordion.vue`:
  - Props: `steps: AgentStep[]`, `status: AgentTurn["status"]`, `durationText?: string`, `terminalFor?: (event: BrowserReplayEvent) => ...`
  - Computed: `pendingApprovalStep`: extracts any approval step without a resolved terminal decision so it renders elevated outside the accordion.
  - Computed: `executionSteps`: thinking and tool steps to display inside the accordion.
  - Computed: `summaryLabel`: e.g., "Đang chạy: Sửa file: src/app.ts" (when running) or "Đã hoàn thành 5 bước" (when done).
  - State: `isOpen`: defaults to `true` while running or when an error occurred, defaults to `false` when done.

- [ ] **Step 1: Write helper logic and tests in `chat-turns.ts` and `chat-turns.test.ts`**

Export pure helper `summarizeProcessState(steps: AgentStep[], status: string)`:
- Returns `{ count: number, activeStepLabel?: string, hasError: boolean }`
- Write tests in `chat-turns.test.ts` verifying step counts and active step extraction.

- [ ] **Step 2: Run test to verify it passes**

Run: `/home/anhnt/.ponta/apps/bun/1.4.3/bun test apps/web/src/features/journal/chat-turns.test.ts`
Expected: PASS

- [ ] **Step 3: Implement `AgentProcessAccordion.vue`**

Create `AgentProcessAccordion.vue`:
- Compact toggle row with step count icon (`Wrench` or `Braces`), spinner when running, duration text, and `ChevronRight`/`ChevronDown`.
- Smooth slide transition for expanded step timeline.
- Pending `ApprovalCard` rendered prominently below or above the toggle row so the user never misses an approval prompt.

- [ ] **Step 4: Update `AgentChatTurn.vue` to use `AgentProcessAccordion`**

Replace the raw `turn.steps` timeline list with `<AgentProcessAccordion :steps="turn.steps" :status="turn.status" :duration-text="turn.durationText" :terminal-for="terminalFor" />`.

- [ ] **Step 5: Run tests and typecheck**

Run: `/home/anhnt/.ponta/apps/bun/1.4.3/bun test && /home/anhnt/.ponta/apps/bun/1.4.3/bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/journal/chat-turns.ts apps/web/src/features/journal/chat-turns.test.ts apps/web/src/components/chat/AgentProcessAccordion.vue apps/web/src/components/chat/AgentChatTurn.vue
git commit -m "feat(web): collapse thinking and tool steps into process accordion"
```

---

### Task 3: Reverse Pagination with Scroll Anchoring

**Files:**
- Modify: `apps/web/src/features/journal/scroll.ts`
- Modify: `apps/web/src/features/journal/scroll.test.ts`
- Modify: `apps/web/src/components/EventJournal.vue`

**Interfaces:**
- `scroll.ts`:
  - `computeScrollAnchorOffset(prevHeight: number, newHeight: number): number` — calculates scroll delta when earlier items are prepended.
  - `isNearTop(scrollTop: number, threshold?: number): boolean` — checks if user scrolled close to top.
- `EventJournal.vue`:
  - `DEFAULT_PAGE_SIZE = 20`
  - `visibleTurnsCount = ref(DEFAULT_PAGE_SIZE)`
  - `displayedTurns = computed(() => turns.value.slice(-visibleTurnsCount.value))`
  - `hasEarlierTurns = computed(() => turns.value.length > visibleTurnsCount.value)`
  - `loadEarlierTurns()`: preserves reading position using `computeScrollAnchorOffset` on `nextTick`.

- [ ] **Step 1: Write pure unit tests in `scroll.test.ts` for scroll anchor and near-top detection**

Add tests:
- `test("computeScrollAnchorOffset returns height difference")`
- `test("isNearTop returns true when within threshold")`

- [ ] **Step 2: Run test to verify it fails**

Run: `/home/anhnt/.ponta/apps/bun/1.4.3/bun test apps/web/src/features/journal/scroll.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement functions in `scroll.ts`**

Implement `computeScrollAnchorOffset` and `isNearTop`.

- [ ] **Step 4: Run test to verify it passes**

Run: `/home/anhnt/.ponta/apps/bun/1.4.3/bun test apps/web/src/features/journal/scroll.test.ts`
Expected: PASS

- [ ] **Step 5: Integrate reverse pagination into `EventJournal.vue`**

- Render `displayedTurns` instead of `turns`.
- Above the turn list, render a subtle "Tải thêm tin nhắn cũ (còn X)" button when `hasEarlierTurns` is true.
- In `onScroll`, when `isNearTop(viewport.scrollTop, 80)` and `hasEarlierTurns.value`, automatically call `loadEarlierTurns()`.
- In `loadEarlierTurns()`: record `viewport.scrollHeight`, increase `visibleTurnsCount.value += 20`, wait for `nextTick()`, and adjust `viewport.scrollTop += computeScrollAnchorOffset(prevHeight, viewport.scrollHeight)`.
- When switching sessions (`props.events` or sessionId change), reset `visibleTurnsCount.value = DEFAULT_PAGE_SIZE`.

- [ ] **Step 6: Run full test suite, typecheck, lint, and build**

Run:
- `/home/anhnt/.ponta/apps/bun/1.4.3/bun test`
- `/home/anhnt/.ponta/apps/bun/1.4.3/bun run typecheck`
- `/home/anhnt/.ponta/apps/bun/1.4.3/bun run lint`
- `cd apps/web && /home/anhnt/.ponta/apps/bun/1.4.3/bun run build`
Expected: All PASS, 0 errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/journal/scroll.ts apps/web/src/features/journal/scroll.test.ts apps/web/src/components/EventJournal.vue
git commit -m "feat(web): add reverse pagination and scroll anchoring to event journal"
```
