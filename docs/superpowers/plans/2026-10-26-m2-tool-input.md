# M2 — Tool Input on the Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each tool row shows what the agent asked the tool to do — a short, display-capped input summary derived browser-side from the `tool_use` blocks of the assistant `message.completed` payloads, correlated by tool call id.

**Architecture:** No new events and no new persistence: `message.completed` already carries the assistant frame's `tool_use` blocks (with full input). The journal derivation — which already processes those events to close streaming entries — additionally records an input summary per tool call id, and the tool entry picks it up whether it was created earlier (`tool.started`) or later (the SDK's complete-before-raw ordering). The mixed-user-frame path is deliberately unchanged: it is rare, it is already key-redacted, and the zero-loss fallback outranks payload hygiene there (ruling below).

**Tech Stack:** Vue 3, Tailwind, bun test. Pure derivation logic only.

**Spec:** `docs/superpowers/plans/2026-10-26-master-roadmap.md` (M2), `docs/ARCHITECTURE.md` §12.3 (structured blocks; tool status from SDK evidence), §19.4 (bounded display of already-persisted content).

## Ruling: mixed frames stay `run.status` (deliberate)

The three alternatives all lose something: emitting `tool.completed` for a mixed frame's blocks AND keeping the frame duplicates the result in the journal; suppressing the frame loses its text blocks (rare but real); mutating the payload (stripping its tool_result blocks) fabricates a frame the SDK never sent. The status quo is redacted (`redactSdkMessage`), visible, and pinned by an executor test. Revisit only if real traffic shows mixed frames are common.

## Global Constraints

- Display-only milestone: nothing the runner emits or persists changes.
- Input summary is display-capped in the derivation (240 chars + `…`) — the full input is already in the `message.completed` payload; the row must not re-render megabytes.
- The summary is `JSON.stringify(input)` of the tool_use input as persisted — no filtering, no interpretation; assistant/tool content is not secret-masked (§12.3 ruling).
- Defensive shape walking at every hop; malformed blocks are skipped, never thrown.
- Tailwind only; tests/comments English; TDD RED→GREEN.

## Review Focus

1. `message.completed` arrives before `tool.started` (the observed SDK ordering quirk): the summary must still land on the row — pinned in Task 1.
2. A tool_use block whose `input` is missing or non-serializable yields no summary rather than `"undefined"` — pinned in Task 1.
3. Oversized input (a `Write` with a whole file) renders capped, and the cap applies at derivation so the template stays dumb — pinned in Task 1.
4. A tool row's state/position must be unchanged by summary attachment — pinned in Task 1 (exact-row assertions).
5. Sessions without any tool events derive identically to before (no regression on existing rows) — the full existing derivation suite stays green untouched.

---

### Task 1: Input summaries in the derivation (web, pure)

**Files:**
- Modify: `apps/web/src/features/journal/streaming-messages.ts`
- Test: `apps/web/src/features/journal/streaming-messages.test.ts`

**Interfaces:**
- Extends: the `kind: "tool"` JournalRow gains `inputSummary: string | null`.
- Consumes: `message.completed` payloads in the executor's redacted `SDKAssistantMessage` shape — `payload.message.content[]` entries with `type === "tool_use"`, non-empty string `id`, own enumerable `input`.
- Produces (Task 2 consumes): `inputSummary` = `JSON.stringify(input)` sliced to 240 chars with a trailing `…` when longer; `null` when absent. Attachment is order-independent: recorded when the completed event is processed, picked up by the tool entry whenever it is created.

- [ ] **Step 1: Write the failing tests** — started → completed(with tool_use) → row has `inputSummary` `{"command":"ls"}`; completed-before-started quirk → summary still lands; oversized input → 240-char slice ending `…`; `input` absent or `undefined` → `null`; tool_use without usable `id` skipped; row state/lastSequence unchanged by attachment; no tool events → no regression (existing suite).
- [ ] **Step 2: Run to verify RED** — rows have `inputSummary: null` / no attachment.
- [ ] **Step 3: Implement** — a `Map<string, string>` of pending summaries filled while processing `message.completed` (reuse the same payload walk that closes streaming entries); tool entries consult it at creation and the completed/started handlers apply it to existing entries.
- [ ] **Step 4: Run to GREEN** — the derivation file, then `bun test apps/web`.
- [ ] **Step 5: Commit** — `git commit -m "feat: derive a tool input summary for each tool row"`.

### Task 2: Render the input summary (web UI)

**Files:**
- Modify: `apps/web/src/components/EventJournal.vue`

The tool row renders `inputSummary` (when present) above `outputSummary`, in the same muted mono style — the row reads "what was asked, then what came back".

- [ ] **Step 1: Implement** the template addition.
- [ ] **Step 2: Verify** — `cd apps/web && bun run build`; `bun test apps/web` green; `bunx biome check .`.
- [ ] **Step 3: Commit** — `git commit -m "feat: show tool input summaries in the journal"`.

### Task 3: Full gates + push + review

- [ ] **Step 1: Gates** — `bun test`, `bun run typecheck`, biome, web build; runner untouched (integration chain unaffected — ledger note).
- [ ] **Step 2: Push**, whole-branch review of the M2 commits, fix pass per protocol.

## Non-goals

- Any runner/persistence change (mixed-frame ruling above; `message.completed` keeps full input — it is the durable transcript).
- Collapsing the live duplicated prose when the complete-before-deltas quirk fires (M1 deferred — owner UX decision).
- Input syntax highlighting or per-tool pretty formatting.
