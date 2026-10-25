# Live Streaming (message.started / message.delta) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The journal streams assistant text while the run is in flight (§12.3/§12.4): the runner normalizes SDK `stream_event` frames into `message.started`/`message.delta`, the pipeline relays them unchanged, and the browser accumulates deltas into one growing bubble per message that `message.completed` finalizes.

**Architecture:** The adapter already enables `includePartialMessages: true`, so `stream_event` frames reach the executor today and are dropped there (`executor.ts:256`). A pure per-run normalizer converts them into the two app-protocol events keyed by the SDK message id. Everything between (outbox → pump → control ingest → replay → browser stream) is type-agnostic and needs zero changes. The web journal derives its rows — run grouping, hidden delta rows, one streaming row per open message — in a pure feature module so bun test can pin all of it.

**Tech Stack:** Bun, TypeScript, Vue 3 (Tailwind utilities only), bun:sqlite.

**Spec:** `docs/ARCHITECTURE.md` §12.3 (normalization: correlate message/block ids, accumulate, finalize once; never expose internal reasoning; tool input parsed only when complete), §12.4 (`message.started`/`message.delta` are app protocol names), perf note "Batch streaming updates; không rerender full chat theo từng delta" (§865).

## Global Constraints

- §4.2: only `packages/agent-adapter` imports the SDK. The normalizer works on plain `Record<string, unknown>` frames; no SDK imports in `apps/runner`.
- Payload shapes are app protocol (§12.4): `message.started` → `{ messageId: string }`; `message.delta` → `{ messageId: string, text: string }` (the fragment, not cumulative). The raw Anthropic event is never persisted or forwarded.
- Thinking deltas and tool-input (`input_json_delta`) fragments are never forwarded (§12.3).
- Assistant text is not secret-masked — same policy as `message.completed` (the redactor's own rule: model output the user asked for is not a leak). No redact call on deltas.
- TDD RED→GREEN per task; tests/comments in English; UI copy Vietnamese with domain nouns in English; Tailwind utilities, no scoped CSS; never edit generated `ui/**`; no version pinning.
- `.superpowers/` ledger local-only, never committed.

## Review Focus

1. A delta arrives whose `message.started` was never seen (client joined mid-stream, replay gap): expect the fragment to be ignored, never a crash or a ghost bubble — pinned by a derivation test in Task 2.
2. `message.completed` for a message the client has no streaming entry for: expect just the completed row, no crash — pinned in Task 2.
3. Sidechain messages (`parent_tool_use_id` set) interleaved with main-chain text: expect deltas to correlate to their own message's id, never bleed across chains — pinned by a normalizer test in Task 1.
4. Run terminal (cancel/abort) while a message is mid-stream: expect the partial text to remain visible inline as an interrupted partial, not vanish — pinned in Task 2 + rendered in Task 3.
5. Replay of a long-finished session (hundreds of delta rows): expect one deterministic derivation — delta rows hidden, one completed row, no streaming bubble — pinned by a replay-determinism test in Task 2.

---

### Task 1: Stream normalizer (runner, pure)

**Files:**
- Create: `apps/runner/src/execution/stream-normalizer.ts`
- Modify: `apps/runner/src/execution/executor.ts` (replace the skip at the `stream_event` branch)
- Test: `apps/runner/src/execution/stream-normalizer.test.ts`

**Interfaces:**
- Produces: `createStreamNormalizer(): (sdkMessage: Record<string, unknown>) => Array<{ type: "message.started" | "message.delta"; payload: Record<string, unknown> }>` — one instance per run; the closure holds the correlation state (current message id keyed by `String(parent_tool_use_id)`).
- Consumes: the executor's `append(type, payload)` (existing).

State machine: `message_start` records `event.message.id` and emits `message.started {messageId}`; `content_block_delta` with `delta.type === "text_delta"` and a live id emits `message.delta {messageId, text}`; every other raw event (`thinking_delta`, `input_json_delta`, `message_delta`, `message_stop`, `content_block_start/stop`, malformed frames) emits nothing. A delta before any `message_start` on its chain emits nothing.

- [ ] **Step 1: Write the failing tests** — `stream-normalizer.test.ts` covering: started-on-message_start; per-fragment deltas correlated by id; `thinking_delta` skipped; `input_json_delta` skipped; delta before start ignored; sidechain (parent `tool-1`) and main (`null`) ids do not bleed; a second `message_start` replaces the chain's id; payloads carry no raw `event` field.
- [ ] **Step 2: Run to verify RED** — `bun test apps/runner/src/execution/stream-normalizer.test.ts` fails (module missing).
- [ ] **Step 3: Implement** the factory per the state machine above.
- [ ] **Step 4: Run to GREEN**, then the executor/daemon unit tests: `bun test apps/runner`. Fix any test that pinned the skip behavior (tests asserting a run's exact event list now see `message.started`/`message.delta` rows — update them to pin the new behavior, never delete the assertion).
- [ ] **Step 5: Wire the executor** — create one normalizer before the message loop; in the `stream_event` branch append each normalized event and `continue` (comment updated to point at the normalizer, not "not built yet").
- [ ] **Step 6: Full runner tests + commit** — `bun test apps/runner && bun run typecheck`; `git commit -m "feat: normalize stream_event into message.started and message.delta"`.

### Task 2: Journal row derivation (web, pure)

**Files:**
- Create: `apps/web/src/features/journal/streaming-messages.ts`
- Test: `apps/web/src/features/journal/streaming-messages.test.ts`

**Interfaces:**
- Consumes: `BrowserReplayEvent` from `@cc-web/protocol` (fields used: `sessionSequence`, `runId`, `type`, `payload`).
- Produces (Task 3 consumes):

```ts
export type JournalRow =
  | { kind: "run"; runId: string; key: string }
  | { kind: "event"; event: BrowserReplayEvent }
  | { kind: "streaming"; key: string; messageId: string; text: string; lastSequence: number; interrupted: boolean };

export function deriveJournalRows(events: BrowserReplayEvent[]): JournalRow[];
```

Rules (single ordered pass): run headers exactly as today; `message.started` and `message.delta` rows are never emitted as rows — deltas accumulate into a streaming entry keyed by `payload.messageId`; `message.completed` whose `payload.id` matches an entry closes it (entry gone, completed event row renders as today); `run.finished`/`run.failed`/`run.interrupted` close all open entries as `interrupted: true` (they stay in the output); a streaming row is emitted inline at the position of its `lastSequence` (the last delta's `sessionSequence`), so it sits between the surrounding visible rows. Malformed payloads (missing/non-string `messageId`, non-string `text`) are ignored.

- [ ] **Step 1: Write the failing tests** — started→deltas→completed (delta rows hidden, completed row present, no streaming row); open deltas → one streaming row inline after the previous visible row, text accumulated; run terminal mid-stream → `interrupted: true`, row remains; delta without started → ignored; completed for unknown id → just the event row; started/completed with no deltas → just the event row; two interleaved messages keep their texts separate; same input array twice → deep-equal output (determinism); malformed payloads ignored.
- [ ] **Step 2: Run to verify RED** — `bun test apps/web/src/features/journal/streaming-messages.test.ts` fails (module missing).
- [ ] **Step 3: Implement** `deriveJournalRows` per the rules above (run-grouping logic moves here from the component).
- [ ] **Step 4: Run to GREEN** — `bun test apps/web/src/features` and full `bun test`.
- [ ] **Step 5: Commit** — `git commit -m "feat: derive journal rows with coalesced streaming messages"`.

### Task 3: EventJournal renders streaming rows

**Files:**
- Modify: `apps/web/src/components/EventJournal.vue` (script: use `deriveJournalRows`; template: add the `streaming` row branch)

**Interfaces:**
- Consumes: `deriveJournalRows` / `JournalRow` (Task 2). `approvalTerminals`/`terminalFor` keep working off `row.event`.

- [ ] **Step 1: Swap the component's `rows` computed to `deriveJournalRows(props.events)`** (delete the local run-grouping); the template iterates the same three kinds, `approval.requested` handling unchanged on `kind === "event"` rows.
- [ ] **Step 2: Render the streaming row** — same grid row idiom as event rows (`76px` gutter showing `lastSequence`, mono type label `message.delta`), body = accumulated text in the same `<pre>` whitespace-pre-wrap idiom; when `interrupted`, add `text-muted-foreground` + suffix "· bị dừng giữa chừng". Tailwind utilities only.
- [ ] **Step 3: Verify** — `bun test` full, `bun run typecheck`, web build (`cd apps/web && bun run build`), `bun run lint`.
- [ ] **Step 4: Live check with the local fake runner** (optional, never committed): extend `/tmp/cc-web-fake-runner.ts` to emit `message.started` + a few `message.delta` frames before `message.completed` on the next prompt; confirm the bubble grows live and is replaced by the completed row.
- [ ] **Step 5: Commit** — `git commit -m "feat: journal streams assistant text while a run is in flight"`.

### Task 4: Probe asserts streaming from the compiled binary

**Files:**
- Modify: `scripts/integration/runner-agent-e2e.ts` (post-poll assertions)

**Interfaces:**
- Consumes: the outbox rows the probe already polls (`SELECT type, payload FROM event_outbox WHERE attempt_id='attempt-1'`).

- [ ] **Step 1: Add conditional assertions** — when the terminal event is `run.finished`: at least one `message.started` row exists, at least one `message.delta` row exists, and every delta payload has a non-empty string `messageId` and `text`. When the terminal is a (credential-shaped) failure: skip the streaming assertions (the run never reached the model).
- [ ] **Step 2: Run the probe** — `bun run scripts/integration/runner-agent-e2e.ts`: all previous checks plus the new ones pass on this host's real credentials.
- [ ] **Step 3: Full integration chain** — `bun run test:integration` (all probes green).
- [ ] **Step 4: Commit** — `git commit -m "feat: probe asserts live streaming events from the compiled binary"`.

### Task 5: Review, fixes, ledger, push

- [ ] **Step 1: Full gates** — `bun test`, `bun run typecheck`, `bun run lint`, web build, integration chain.
- [ ] **Step 2: Push** to `main`.
- [ ] **Step 3: Fresh whole-branch review** (general-purpose subagent, `code-reviewer.md` template) over the milestone range; re-grade findings by effect; Critical/Important → one RED→GREEN fix pass; Minor → ledger as deferred; push fixes.
- [ ] **Step 4: Ledger + memory update**, final Vietnamese report.

## Non-goals

- `tool.started`/`tool.completed` timeline events (separate milestone).
- Pump coalescing/throttling of delta frames (flush-per-event stays until measured otherwise).
- Markdown rendering of assistant text in the journal (transcript idiom stays).
- Thinking or tool-input streaming (never, per §12.3).
- `run.status` progress events.
