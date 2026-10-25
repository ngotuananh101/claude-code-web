# Tool Timeline (tool.started / tool.completed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The journal shows tool calls as they happen (§12.3/§12.4): the runner emits `tool.started` when the SDK stream opens a `tool_use` block and `tool.completed` when the matching `tool_result` frame arrives, and the browser pairs them into one row per tool call with a live running/done/error state.

**Architecture:** Two independent evidence sources, both already flowing through the executor: raw `stream_event` frames (a `content_block_start` with a `tool_use` block names the call) and complete `user` frames (their `tool_result` blocks are the SDK's evidence the tool ran — today they land as generic `run.status` JSON noise). The stream normalizer gains `tool.started`; a new pure module maps pure-tool-result user frames to `tool.completed` events and suppresses the noisy frame; the browser derivation pairs both ids into one settled row per call, mirroring the streaming-message derivation. Everything between (outbox → pump → control ingest → replay → browser stream) is type-agnostic and needs zero changes; `EventType` already contains both names.

**Tech Stack:** Bun, TypeScript, Vue 3 (Tailwind utilities only), bun:sqlite.

**Spec:** `docs/ARCHITECTURE.md` §12.3 (tool input parsed only when complete; tool status from SDK/hook evidence, never inferred from model prose; structured blocks, redaction policy), §12.4 (`tool.started`/`tool.completed` are app protocol names), §19.4 (credentials and command payloads never logged; bounded payloads).

## Global Constraints

- §4.2: only `packages/agent-adapter` imports the SDK. Both new modules work on plain `Record<string, unknown>` frames; no SDK imports in `apps/runner`.
- Payload shapes are app protocol (§12.4): `tool.started` → `{ toolCallId: string, toolName: string }`; `tool.completed` → `{ toolCallId: string, isError: boolean, outputSummary?: string }` (`outputSummary` present only when non-empty). The tool call id is the SDK's `tool_use` id and correlates `tool_result.tool_use_id` to it.
- Tool input is never echoed in `tool.started` (it is incomplete at block start and is arbitrary model JSON). Tool result content travels only as `outputSummary` produced by the existing `summarizeToolInput` (secret-masked, 2000-char cap — the §13 pattern: the summary travels, the full payload never leaves).
- §12.3: `content_block_stop` is NOT completion evidence (the model finished emitting input ≠ the tool finished). Completion comes only from a `tool_result` block.
- TDD RED→GREEN per task; tests/comments in English; UI copy Vietnamese with domain nouns in English; Tailwind utilities, no scoped CSS; never edit generated `ui/**`; no version pinning.
- `.superpowers/` ledger local-only, never committed.

## Review Focus

1. `tool.completed` for a `toolCallId` with no prior `tool.started` (replay gap, or the SDK ordering quirk already observed with text — complete frames can precede their own raw stream events): expect a settled row with a fallback name, never a crash or a dropped event — pinned in Task 3.
2. A run terminal while a tool is in flight (cancel mid-tool): expect the row to stay visible marked interrupted, mirroring streaming partials — pinned in Task 3.
3. Sidechain tool calls (`parent_tool_use_id` set on the raw frame): expect them forwarded as their own rows — tool ids are globally unique, nothing bleeds across chains — pinned in Task 1.
4. A user frame with mixed content (text and `tool_result` blocks together): expect it to keep arriving as `run.status` unchanged — unexpected shapes stay visible, never silently half-mapped — pinned in Task 2.
5. Malformed frames (a `tool_use` block without id/name, a `tool_result` without `tool_use_id`, non-array content): expect the frame/block to be ignored, never a throw or a ghost row — pinned in Tasks 1–3.

---

### Task 1: `tool.started` in the stream normalizer (runner, pure)

**Files:**
- Modify: `apps/runner/src/execution/stream-normalizer.ts`
- Test: `apps/runner/src/execution/stream-normalizer.test.ts`

**Interfaces:**
- Extends: `NormalizedStreamEvent.type` gains `"tool.started"` — the executor's existing `for (const normalized of normalize(sdkMessage)) append(...)` loop (executor.ts:258) needs no change.
- Produces: on a raw `content_block_start` whose `content_block.type === "tool_use"` with non-empty string `id` and `name`, emit `{ type: "tool.started", payload: { toolCallId: id, toolName: name } }`. The chain key (`parent_tool_use_id`) is irrelevant here — tool ids are globally unique; do not consult or update `currentId`.

- [ ] **Step 1: Write the failing tests** — extend `stream-normalizer.test.ts`: a `content_block_start` with a `tool_use` block emits `tool.started {toolCallId, toolName}`; a `text` block start emits nothing; a `tool_use` block missing `id` or `name` (or non-string) emits nothing; a sidechain frame (`parent_tool_use_id: "toolu-1"`) still emits its own `tool.started`; the payload key set is exactly `{toolCallId, toolName}`; a `content_block_stop` for a tool block emits nothing (§12.3).
- [ ] **Step 2: Run to verify RED** — `bun test apps/runner/src/execution/stream-normalizer.test.ts` fails (no `tool.started` emitted).
- [ ] **Step 3: Implement** the `content_block_start` branch per the interface above and widen `NormalizedStreamEvent.type`. Update the module doc comment to name the third event.
- [ ] **Step 4: Run to GREEN** — the normalizer file; then `bun test apps/runner` (executor fixtures with `stream_event` generators gain no new rows unless they contain `tool_use` block starts — fix any test that pinned otherwise, never delete the assertion).
- [ ] **Step 5: Commit** — `git commit -m "feat: emit tool.started from tool_use block starts"`.

### Task 2: `tool.completed` from user frames (runner, pure + executor wiring)

**Files:**
- Create: `apps/runner/src/execution/tool-results.ts`
- Modify: `apps/runner/src/execution/executor.ts` (the message loop, before the `eventTypeOf` append at executor.ts:263)
- Test: `apps/runner/src/execution/tool-results.test.ts`, `apps/runner/src/execution/executor.test.ts`

**Interfaces:**
- Consumes: `summarizeToolInput(input: unknown): string` from `./redact.ts` (existing).
- Produces (Task 3 consumes the emitted events):
  - `isToolResultFrame(message: Record<string, unknown>): boolean` — true when `message.type === "user"`, `message.message.content` is a non-empty array, and EVERY entry has `type === "tool_result"` with a non-empty string `tool_use_id`. Mixed/string/empty content → false.
  - `toolCompletionsOf(message: Record<string, unknown>): Array<{ toolCallId: string; isError: boolean; outputSummary?: string }>` — one entry per `tool_result` block of such a frame, in content order. `isError` is `block.is_error === true`. `outputSummary` is `summarizeToolInput` of the flattened text (`content` string as-is; array → its `type === "text"` blocks' `text` joined with `"\n"`), included only when non-empty. Blocks without a usable id are skipped; returns `[]` for any non-tool-result frame.
- Executor wiring: in the message loop, `if (type === "user" && isToolResultFrame(sdkMessage)) { for (const c of toolCompletionsOf(sdkMessage)) append("tool.completed", c); continue; }` — the frame itself is no longer persisted as `run.status` (the events replace the JSON noise; the full result never left the runner).

- [ ] **Step 1: Write the failing tests** — `tool-results.test.ts`: a pure tool-result frame is recognized (two blocks → two completions in order, `isError` both ways, `outputSummary` from string content and from text-block arrays, omitted when no text); a mixed frame (text + tool_result) is NOT a tool-result frame and yields no completions; string content → false/`[]`; a block missing `tool_use_id` is skipped; malformed message shapes → `[]` without throwing.
- [ ] **Step 2: Run to verify RED** — module missing.
- [ ] **Step 3: Implement** per the interfaces above.
- [ ] **Step 4: Run to GREEN**, then add the executor contract test in `executor.test.ts`: a generator yielding `system init` → `stream_event content_block_start(tool_use id "toolu-1", name "Bash")` → `assistant` frame whose `message.content` carries the same `tool_use` block → `user` frame with `tool_result` for `toolu-1` → `result success` must produce the outbox list `["run.started","session.updated","tool.started","message.completed","tool.completed","run.finished"]` AND the two tool payloads' `toolCallId` values equal each other (the correlation Task 3 depends on; the assistant frame must not disturb the tool events). RED first (today the user frame lands as `run.status`), then wire the loop, then GREEN; run `bun test apps/runner` and fix any test that pinned user frames as `run.status` (only such fixtures change — never delete the assertion).
- [ ] **Step 5: Commit** — `git commit -m "feat: map tool_result user frames to tool.completed events"`.

### Task 3: Tool rows in the journal derivation (web, pure)

**Files:**
- Modify: `apps/web/src/features/journal/streaming-messages.ts`
- Test: `apps/web/src/features/journal/streaming-messages.test.ts`

**Interfaces:**
- Consumes: `BrowserReplayEvent`; `tool.started {toolCallId, toolName}` and `tool.completed {toolCallId, isError, outputSummary?}` events (Task 2's shapes).
- Produces (Task 4 consumes): `JournalRow` gains `{ kind: "tool"; key: string; toolCallId: string; toolName: string | null; state: "running" | "done" | "error" | "interrupted"; outputSummary: string | null; lastSequence: number }` (`key = "tool-" + toolCallId`).

State machine (mirrors the streaming entries): `tool.started` creates/updates the entry (`toolName`, `lastSequence`) — a started for an id already settled by a completed only fills `toolName` (the observed SDK ordering quirk: complete frames can precede their own raw stream events; it must not reopen a settled row). `tool.completed` settles the entry (`state` from `isError`, `outputSummary`, `lastSequence`), creating it with `toolName: null` when no started was seen. Run terminals mark `running` entries `interrupted`. Neither event type renders as a generic event row. Placement: the existing inline scan flushes tool entries by `lastSequence` exactly like streaming entries; unplaced entries land in the live tail.

- [ ] **Step 1: Write the failing tests** — started+completed pair → exactly one settled `done` row with the name and `outputSummary` (no generic `tool.*` event rows); started only → one `running` row in the live tail; error completion → `state: "error"`; run terminal mid-tool → `interrupted`; completed for an unknown id → settled row with `toolName: null`; a late started after completion fills the name without reopening; malformed payloads (missing/typed-wrong `toolCallId`) ignored; two distinct tool calls → two rows in started order; determinism on replay.
- [ ] **Step 2: Run to verify RED** — tool rows come out as generic event rows instead.
- [ ] **Step 3: Implement** the tool map + placement scan alongside `open`.
- [ ] **Step 4: Run to GREEN** — the derivation file, then `bun test apps/web`.
- [ ] **Step 5: Commit** — `git commit -m "feat: pair tool events into one journal row per call"`.

### Task 4: Render tool rows (web UI)

**Files:**
- Modify: `apps/web/src/components/EventJournal.vue`

**Interfaces:**
- Consumes: the `kind: "tool"` row from Task 3 (fields above).

Rendering, in the journal's existing idiom (grid gutter + label line + optional pre): gutter shows `lastSequence`; label line is `tool · {{ toolName ?? "…" }}` in the muted mono style, followed by a state suffix — `đang chạy` (muted) while running, `lỗi` (destructive) on error, `bị dừng giữa chừng` (muted) on interrupted, nothing on done; `outputSummary` renders under it in the muted `pre` style of the streaming row. No new components, Tailwind only.

- [ ] **Step 1: Add the template branch** `v-else-if="row.kind === 'tool'"` between the event and streaming branches.
- [ ] **Step 2: Verify** — `cd apps/web && bun run build` (bun test cannot compile SFCs; the derivation tests in Task 3 carry the behavior).
- [ ] **Step 3: Commit** — `git commit -m "feat: render tool call rows in the journal"`.

### Task 5: Probe the real CLI + full gates

**Files:**
- Modify: `scripts/integration/runner-agent-e2e.ts` (prompt + checks)

**Interfaces:**
- Consumes: Tasks 1–2 end to end through the compiled binary.

Change the run prompt to one that forces a tool call (`Use the Bash tool to run \`echo hi\` and reply with its output.` — a prompt, never printed). New checks, gated on `terminal?.type === "run.finished"` like the streaming ones: `tool.started` rows ≥ 1 with every payload a `{toolCallId: string, toolName: non-empty string}`; `tool.completed` rows ≥ 1; every completed `toolCallId` appeared in a started payload. Detail lines print counts only (§19.4).

- [ ] **Step 1: Update the prompt and add the checks.**
- [ ] **Step 2: Run** `bun run scripts/integration/runner-agent-e2e.ts` — expect all checks green including the new ones (the real CLI's raw frames and user frames flow through the new mapping).
- [ ] **Step 3: Full gates** — `bun test`, `bun run typecheck`, `bunx biome check .`, web build, `bun run test:integration` (existing chain must stay green).
- [ ] **Step 4: Commit and push** — `git commit -m "test: assert tool events in the agent e2e probe"`, push to `main`, then the whole-branch review per the standing protocol.

## Non-goals

- Tool result content beyond the summary (no full output replay; the complete user frame is simply gone from the journal — revisit if operators need it).
- Tool input display on the timeline (lives in `message.completed` payloads already).
- `question.requested`/`question.answered` mapping (AskUserQuestion rides §13 approvals today).
- Coalescing `run.status` frames from other SDK system subtypes (out of evidence scope).
