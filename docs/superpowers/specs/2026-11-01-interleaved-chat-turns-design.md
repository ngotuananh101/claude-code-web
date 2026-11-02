# Interleaved Process Steps and Text Outputs in Agent Chat Turns

**Status:** Draft proposal (2026-11-01)  
**Target:** `apps/web/src/features/journal/chat-turns.ts`, `apps/web/src/components/chat/AgentChatTurn.vue`, `apps/web/src/components/chat/AgentProcessAccordion.vue`

---

## 1. Context and Problem Statement

In the current `cc-web` journal implementation, each assistant turn (`AgentTurn`) models execution activity as two decoupled collections:
1. `steps: AgentStep[]`: all tool executions, thinking blocks, and approvals across the entire turn, rendered in a single `AgentProcessAccordion` at the top of the turn bubble.
2. `text: string`: all assistant prose text emitted during the turn, concatenated and rendered in a single markdown prose block below the accordion.

### The Problem
Coding agents typically operate in multi-phase cycles within a single prompt turn:
$$\text{Tools (e.g. Read / Grep)} \longrightarrow \text{Interim Text (e.g. "Found bug in X, modifying...")} \longrightarrow \text{Tools (e.g. Edit / Bash)} \longrightarrow \text{Final Output}$$

Under the current implementation, all 4 tool calls are gathered into one single header accordion, and all text blocks are concatenated into one bottom prose section:
```
[ Accordion: 4 steps performed ]
"Found bug in X, modifying..."
"All tests pass, here is the summary..."
```
This destroys the chronological narrative and causality of the agent's work. The user cannot tell which tools were executed to produce the interim conclusion versus the final conclusion.

### User Request
Interleave process blocks and prose outputs chronologically:
- Consecutive tool calls / thinking blocks are grouped into a process accordion frame.
- Text output generated at that point in time appears directly beneath its preceding process frame.
- Subsequent tool calls open a new process frame beneath the text.
- Prior (historical/settled) process frames within the turn default to collapsed, so only the active or latest frame draws attention while older steps remain expandable on click.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
1. **Chronological Segment Modeling (`AgentTurnSegment`)**:
   Model the contents of an `AgentTurn` as an ordered sequence of typed segments:
   - `ProcessSegment` (`kind: "process"`): Contains contiguous `AgentStep`s (tools, thinking, approvals).
   - `TextSegment` (`kind: "text"`): Contains the assistant markdown prose produced at that juncture.
2. **Deterministic Segmentation in `deriveChatTurns`**:
   - Accurately segment historical session messages (`SessionMessage[]`) by observing the interleaving order of content blocks (`thinking`, `tool_use`, `text`) and assistant/user-tool-result message boundaries.
   - Accurately segment live events (`BrowserReplayEvent[]`) as streaming deltas (`message.delta`) and tool calls (`tool.started`) arrive in real time.
3. **Collapsing Semantics**:
   - Past process accordions in the turn default to collapsed (`isOpen = false`).
   - The active/latest process accordion remains open while running or in error, and collapses upon completion (honoring existing accordion behavior).
   - The operator can manually expand or collapse any accordion at any time.
4. **Backward Compatibility**:
   - `AgentTurn.steps` remains populated with all flattened steps.
   - `AgentTurn.text` remains populated with the full concatenated response text.
   - Existing external consumers (e.g., search, copy full response, raw payload view, session stats) continue to work without modification.

### Non-Goals
- Changing the backend database schema, runner protocol, or SSE stream. This is strictly a frontend parsing and presentation enhancement.
- Changing `UserTurn` or how user prompts are parsed.
- Breaking monolithic markdown streaming: `message.delta` streaming should seamlessly stream into the current active `TextSegment`.

### Anti-Goals
- Zero empty segments: Never produce a `process` segment with 0 steps, nor a `text` segment with empty string prose.
- No flickering: Receiving a streaming text token must not cause preceding process accordions to remount or lose their open/closed state.

---

## 3. Data Model

In `apps/web/src/features/journal/chat-turns.ts`:

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

export type AgentTurn = {
  kind: "agent";
  key: string;
  runId?: string;
  status: "running" | "done" | "error" | "interrupted";
  durationText?: string;
  startedAt?: string;
  /** Flattened list of all steps across all segments (backward compatibility). */
  steps: AgentStep[];
  /** Full concatenated prose text across all segments (backward compatibility). */
  text: string;
  /** Chronologically interleaved segments. */
  segments: AgentTurnSegment[];
  isStreaming?: boolean;
  rawPayload?: unknown;
};
```

---

## 4. Parser Implementation (`deriveChatTurns`)

### 4.1 Historical Message Processing

In Claude conversation history, an assistant message can contain an array of content blocks:
- `thinking`
- `tool_use`
- `text`

Between assistant calls that yield `tool_use`, user messages containing `tool_result` appear.

#### Segmentation Algorithm:
When walking `historicalMessages`:
1. When starting an `AgentTurn`, initialize `segments: AgentTurnSegment[] = []`.
2. Inspect the sequence of blocks within assistant messages:
   - **Thinking / Tool Use**:
     - If the last segment in `segments` is `kind: "process"`, append the new `ThinkingStep` or `ToolStep` to `lastSegment.steps`.
     - Otherwise, push a new `ProcessSegment` with `key: `${agent.key}-seg-${segments.length}`` and `steps: [step]`.
     - Also push to `agent.steps` (flattened list).
   - **Text Block (Prose)**:
     - If the text is non-empty:
       - If the last segment in `segments` is `kind: "text"`, append to it (`lastSegment.text += (lastSegment.text ? "\n\n" : "") + prose`).
       - Otherwise, push a new `TextSegment` with `key: `${agent.key}-seg-${segments.length}`` and `text: prose`.
       - Also append to `agent.text` (flattened string).
3. If multiple assistant messages follow each other without intervening user prompts (e.g. multi-step tool calls):
   - Steps and text blocks naturally flow into the ongoing `segments` array, grouping contiguous tools into a single `ProcessSegment` and contiguous text into a single `TextSegment`.

### 4.2 Live Event Stream Processing

Live events arrive sequentially:
- `tool.started` / `tool.completed`
- `message.delta` (streaming text chunks)
- `message.completed` (final message snapshot)

#### Live Segmentation Rules:
1. When `run.started` initializes `liveAgentTurn`:
   - Initialize `segments: []`.
2. When `tool.started` arrives:
   - If the last segment is `kind: "process"`, add the new `ToolStep` to `lastSegment.steps`.
   - If the last segment is `kind: "text"` (or `segments` is empty), push a new `ProcessSegment` (`kind: "process"`, `steps: [newStep]`).
   - Also append to `liveAgentTurn.steps`.
3. When `message.delta` arrives with text:
   - If the last segment is `kind: "text"`, append `delta.text` to `lastSegment.text`.
   - If the last segment is `kind: "process"` (or `segments` is empty), push a new `TextSegment` (`kind: "text"`, `text: delta.text`).
   - Also append to `liveAgentTurn.text`.
4. When `approval.requested` arrives:
   - Approvals are steps (`kind: "approval"`). If the last segment is `kind: "process"`, append to it; otherwise start a new `ProcessSegment`.
5. Edge cases:
   - If a turn has only text and no tools: `segments` has exactly 1 `TextSegment`.
   - If a turn has only tools and no text: `segments` has exactly 1 `ProcessSegment`.
   - If live event deduplication or replay backfills from history, preserve segments cleanly without duplicate keys.

---

## 5. UI Presentation (`AgentChatTurn.vue` & `AgentProcessAccordion.vue`)

### 5.1 Sequential Rendering in `AgentChatTurn.vue`

Instead of fixed top accordion + fixed bottom prose:
```html
<template>
  <div class="group flex flex-col gap-2.5 w-full min-w-0 max-w-full text-foreground">
    <!-- Turn Header -->
    ...

    <!-- Interleaved Segments -->
    <template v-for="(seg, idx) in turn.segments" :key="seg.key">
      <!-- Process Accordion for consecutive steps -->
      <AgentProcessAccordion
        v-if="seg.kind === 'process' && seg.steps.length > 0"
        :steps="seg.steps"
        :status="isLastProcessSegment(idx) ? turn.status : 'done'"
        :duration-text="isLastProcessSegment(idx) ? turn.durationText : undefined"
        :terminal-for="terminalFor"
        :task-for="taskFor"
      />

      <!-- Assistant Prose for this phase -->
      <div
        v-else-if="seg.kind === 'text' && seg.text"
        :class="proseClasses"
        class="min-w-0 max-w-full break-words"
        v-html="renderMarkdown(seg.text)"
      />
    </template>

    <!-- Unified CLI-style live status while turn is running, always at the tail -->
    <AgentLiveStatus
      v-if="shouldShowLiveStatus"
      :turn="turn"
      :steps="turn.steps ?? []"
      :pending-approval-count="pendingApprovalCount"
    />

    <!-- Actions row (Copy response, Raw JSON) -->
    ...
  </div>
</template>
```

### 5.2 Accordion Default State and Collapsing Semantics

The user specified: **"thu gọn các khung cũ lại nhé"** (collapse the old frames).
- We pass `:status="isLastProcessSegment(idx) ? turn.status : 'done'"` to each `AgentProcessAccordion`.
- Because `AgentProcessAccordion` initializes `isOpen = ref(props.status === 'running' || props.status === 'error')`, any past process segment (with `:status="'done'"`) naturally initializes to `isOpen = false` (collapsed).
- Only the currently active/latest process segment (with `:status="turn.status"`) starts open while `running`, and automatically collapses when `turn.status` transitions to `done`.
- If an operator manually clicks to expand a previous accordion, their explicit choice is respected (local `isOpen` state in that component is preserved).

### 5.3 Segment Keys & Stability
- Segment keys are deterministic: `${agent.key}-process-${count}` and `${agent.key}-text-${count}`.
- Because `agent.key` is pinned to the message UUID or run ID, segment keys remain stable across re-renders and re-derivations.
- All segmentation logic is contained within `apps/web/src/features/journal/chat-turns.ts`. Both `segments`, `steps` (flattened), and `text` (concatenated) are populated during the single pass in `deriveChatTurns`.

---

## 6. Testing and Verification Plan

### Unit Tests (`chat-turns.test.ts`)
1. **Multi-phase historical interleaving**:
   - A historical turn with `[tool_use 1, tool_use 2]`, `[text 1]`, `[tool_use 3]`, `[text 2]` yields 4 segments in exact alternating order: `[process(2), text, process(1), text]`.
2. **Consecutive tools collapsing**:
   - Multiple `tool_use` blocks without intervening text yield exactly 1 `ProcessSegment` with all steps.
3. **Consecutive text collapsing**:
   - Multiple text blocks without intervening tools yield exactly 1 `TextSegment`.
4. **Live event streaming interleaving**:
   - Sequence: `run.started` $\rightarrow$ `tool.started` (id1) $\rightarrow$ `tool.completed` (id1) $\rightarrow$ `message.delta` ("Part 1") $\rightarrow$ `tool.started` (id2) $\rightarrow$ `tool.completed` (id2) $\rightarrow$ `message.delta` ("Part 2") $\rightarrow$ `run.finished`.
   - Asserts 4 segments are formed with correct step and text contents.
5. **Backwards compatibility**:
   - Asserts `turn.steps` contains all steps across all segments.
   - Asserts `turn.text` contains all text across all segments.
6. **Pure text turn & Pure tool turn**:
   - Edge case with 0 tools $\rightarrow$ 1 `TextSegment`.
   - Edge case with 0 text $\rightarrow$ 1 `ProcessSegment`.

### Component Verification (`AgentChatTurn.vue`)
- Run `bun test` across the full test suite.
- Run `bun run typecheck` (including `vue-tsgo`).
- Run `bun run lint`.
- Build web app with `cd apps/web && bun run build`.
