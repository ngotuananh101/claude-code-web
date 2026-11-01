# Interleaved Process Steps and Text Outputs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Interleave tool execution process frames and assistant markdown prose chronologically within `AgentChatTurn`, collapsing past process frames while keeping the active frame open.

**Architecture:** Extend `AgentTurn` with typed `segments: AgentTurnSegment[]` (`ProcessSegment` | `TextSegment`). In `deriveChatTurns`, group contiguous tool/thinking steps into `ProcessSegment`s and contiguous prose into `TextSegment`s across both historical replay and live event streams, while preserving flattened `steps` and `text` for backward compatibility. In `AgentChatTurn.vue`, render segments sequentially, passing `:status="'done'"` to historical process accordions so they default collapsed, while the active/trailing accordion tracks `turn.status`.

**Tech Stack:** TypeScript, Vue 3, Vitest, `@cc-web/protocol`.

**Spec:** `docs/superpowers/specs/2026-11-01-interleaved-chat-turns-design.md`

## Global Constraints

- Never edit/lint/format generated shadcn-vue files (`apps/web/src/components/ui/**`, `apps/web/src/lib/utils.ts`, `apps/web/src/styles/index.css`, `apps/web/components.json`).
- Checks must pass: `bun test`, `bun run typecheck` (`tsc -b` + `typecheck:vue`), `bun run lint` (`biome`).
- Web build: `cd apps/web && bun run build`.
- Zero empty segments: never produce a `process` segment with 0 steps, nor a `text` segment with empty string.
- Backward compatibility: `AgentTurn.steps` must keep all flattened steps and `AgentTurn.text` must keep the concatenated prose string.

## Review Focus

1. **Empty text delta or whitespace-only streaming**: A streaming event with empty text must not create an empty `TextSegment`.
2. **Consecutive tool calls with no intervening text**: Multiple tool steps must merge into a single `ProcessSegment` rather than creating separate accordions for each tool.
3. **Turn with no tool calls (prose only)**: Produces exactly one `TextSegment` and zero `ProcessSegment`s without crashing or rendering phantom accordions.
4. **Turn with no prose (tools only)**: Produces exactly one `ProcessSegment` and zero `TextSegment`s without crashing or rendering empty text containers.
5. **Replay deduplication between historical messages and live runs**: Transition from historical replay to live stream preserves existing segments without duplicate keys or discarded steps.

---

### Task 1: Type Definitions and Historical Replay Segmentation

**Files:**
- Modify: `apps/web/src/features/journal/chat-turns.ts:35-85`, `apps/web/src/features/journal/chat-turns.ts:700-775`
- Test: `apps/web/src/features/journal/chat-turns.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export type ProcessSegment = {
    kind: "process";
    key: string;
    steps: AgentStep[];
  };

  export type TextSegment = {
    kind: "text";
    key: string;
    text: string;
  };

  export type AgentTurnSegment = ProcessSegment | TextSegment;
  ```
- Updates `AgentTurn`:
  ```typescript
  export type AgentTurn = {
    ...
    steps: AgentStep[];
    text: string;
    segments: AgentTurnSegment[];
    ...
  };
  ```

- [ ] **Step 1: Write failing tests for historical message segmentation**

In `apps/web/src/features/journal/chat-turns.test.ts`, add test cases:
1. `segments an assistant turn containing tools, interim text, more tools, and final text`:
   Provide historical messages with tool calls, followed by text, followed by more tool calls and final text.
   Assert:
   - `turn.segments.length === 4`
   - `turn.segments[0].kind === "process"` with 2 tool steps
   - `turn.segments[1].kind === "text"` with interim prose
   - `turn.segments[2].kind === "process"` with 1 tool step
   - `turn.segments[3].kind === "text"` with final prose
   - `turn.steps.length === 3` (flattened backward compatibility)
   - `turn.text` contains both prose blocks joined by `\n\n`.
2. `pure text turn yields exactly one text segment`
3. `pure tool turn yields exactly one process segment`
4. `consecutive tools without text merge into a single process segment`

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.ponta/bin:$PATH"; bun test apps/web/src/features/journal/chat-turns.test.ts`
Expected: FAIL (property `segments` does not exist on `AgentTurn`).

- [ ] **Step 3: Implement types and historical segmentation in `chat-turns.ts`**

In `apps/web/src/features/journal/chat-turns.ts`:
1. Define and export `ProcessSegment`, `TextSegment`, `AgentTurnSegment`.
2. Add `segments: AgentTurnSegment[]` to `AgentTurn`.
3. In `deriveChatTurns`, update historical assistant message handling:
   - When creating `currentAgentTurn`: initialize `segments: []`.
   - Inspect blocks of the assistant message or sequence of messages:
     - For `thinking` and `tool_use`: if `lastSegment.kind === "process"`, append step; otherwise push a new `ProcessSegment` with key `${agent.key}-seg-${agent.segments.length}`.
     - For non-empty prose: if `lastSegment.kind === "text"`, append text; otherwise push a new `TextSegment` with key `${agent.key}-seg-${agent.segments.length}`.
   - Maintain flattened `agent.steps.push(...)` and `agent.text` as before.

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$HOME/.ponta/bin:$PATH"; bun test apps/web/src/features/journal/chat-turns.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/journal/chat-turns.ts apps/web/src/features/journal/chat-turns.test.ts
git commit -m "feat(web): add AgentTurnSegment types and segment historical chat turns"
```

---

### Task 2: Live Event Stream Segmentation

**Files:**
- Modify: `apps/web/src/features/journal/chat-turns.ts:840-980`
- Test: `apps/web/src/features/journal/chat-turns.test.ts`

**Interfaces:**
- Consumes: `AgentTurnSegment`, `ProcessSegment`, `TextSegment` from Task 1.
- Produces: Live streamed `AgentTurn` with up-to-date `segments` responding to `tool.started`, `message.delta`, `message.completed`, `approval.requested`.

- [ ] **Step 1: Write failing test for live event stream segmentation**

In `apps/web/src/features/journal/chat-turns.test.ts`, add test cases:
1. `interleaves live stream tool steps and streaming text deltas`:
   Send events:
   - `run.started`
   - `tool.started` (id: t1)
   - `tool.completed` (id: t1)
   - `message.delta` (text: "Found files")
   - `message.delta` (text: ", inspecting...")
   - `tool.started` (id: t2)
   - `tool.completed` (id: t2)
   - `message.delta` (text: "All done.")
   - `run.finished`
   Assert:
   - `turn.segments.length === 4`
   - `turn.segments[0]` is `process` with tool t1
   - `turn.segments[1]` is `text` with "Found files, inspecting..."
   - `turn.segments[2]` is `process` with tool t2
   - `turn.segments[3]` is `text` with "All done."
2. `empty message.delta does not create empty text segment`
3. `live approval.requested attaches to current process segment or starts a new one`

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.ponta/bin:$PATH"; bun test apps/web/src/features/journal/chat-turns.test.ts`
Expected: FAIL (live turns have empty `segments` or wrong segment counts).

- [ ] **Step 3: Implement live event segmentation in `chat-turns.ts`**

In `apps/web/src/features/journal/chat-turns.ts`:
1. In `run.started`: initialize `liveAgentTurn` with `segments: []`.
2. In `tool.started`:
   - Append step to `liveAgentTurn.steps`.
   - If `lastSegment?.kind === "process"`, push step to `lastSegment.steps`.
   - Else, push new `ProcessSegment` to `liveAgentTurn.segments`.
3. In `message.delta`:
   - If `delta.text` is empty string or undefined, ignore.
   - Append to `liveAgentTurn.text`.
   - If `lastSegment?.kind === "text"`, append `delta.text` to `lastSegment.text`.
   - Else, push new `TextSegment` to `liveAgentTurn.segments`.
4. In `approval.requested`:
   - If `lastSegment?.kind === "process"`, push approval step to `lastSegment.steps`.
   - Else, push new `ProcessSegment` with approval step.
5. In `message.completed`:
   - Ensure content blocks backfill missing text/tool inputs into the current segment cleanly without wiping out existing segments.

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$HOME/.ponta/bin:$PATH"; bun test apps/web/src/features/journal/chat-turns.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/journal/chat-turns.ts apps/web/src/features/journal/chat-turns.test.ts
git commit -m "feat(web): segment live event streams into interleaved chat turn segments"
```

---

### Task 3: Interleaved Rendering and Collapsing in `AgentChatTurn.vue`

**Files:**
- Modify: `apps/web/src/components/chat/AgentChatTurn.vue:120-150`
- Test: `apps/web/src/features/journal/chat-turns.test.ts`
- Verification: Full suite + typecheck + lint + build

**Interfaces:**
- Consumes: `turn.segments` from `AgentTurn`.
- Produces: Interleaved rendering of `AgentProcessAccordion` and prose blocks in chronological order.

- [ ] **Step 1: Inspect and update `AgentChatTurn.vue`**

In `apps/web/src/components/chat/AgentChatTurn.vue`:
1. Add helper computed or method to find the last process segment index:
   ```typescript
   function isLastProcessSegment(idx: number): boolean {
     for (let i = (props.turn.segments?.length ?? 0) - 1; i >= 0; i--) {
       if (props.turn.segments[i]?.kind === "process") {
         return i === idx;
       }
     }
     return false;
   }
   ```
2. Replace the fixed top `<AgentProcessAccordion>` and bottom `<div v-if="turn.text"...>` with:
   - A `v-for="(seg, idx) in turn.segments" :key="seg.key"` loop.
   - For `seg.kind === 'process'`:
     ```html
     <AgentProcessAccordion
       v-if="seg.steps.length > 0"
       :steps="seg.steps"
       :status="isLastProcessSegment(idx) ? turn.status : 'done'"
       :duration-text="isLastProcessSegment(idx) ? turn.durationText : undefined"
       :terminal-for="terminalFor"
       :task-for="taskFor"
     />
     ```
   - For `seg.kind === 'text'`:
     ```html
     <div
       v-if="seg.text"
       :class="proseClasses"
       class="min-w-0 max-w-full break-words"
       v-html="renderMarkdown(seg.text)"
     />
     ```
3. Fallback: if `turn.segments` is undefined or empty (for legacy test fixtures without segments), fall back to rendering `completedSteps` and `turn.text`.
4. Keep `AgentLiveStatus` below the interleaved segments, visible when `shouldShowLiveStatus` is true.

- [ ] **Step 2: Run all tests to verify nothing broke**

Run: `export PATH="$HOME/.ponta/bin:$PATH"; bun test`
Expected: 1986+ tests pass, 0 failures.

- [ ] **Step 3: Run typecheck and lint**

Run: `export PATH="$HOME/.ponta/bin:$PATH"; bun run typecheck && bun run lint`
Expected: All TypeScript checks pass (including `vue-tsgo`) and Biome lint is clean.

- [ ] **Step 4: Verify web production build**

Run: `export PATH="$HOME/.ponta/bin:$PATH"; cd apps/web && bun run build`
Expected: Build succeeds with 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/AgentChatTurn.vue
git commit -m "feat(web): render interleaved process accordions and prose in AgentChatTurn"
```
