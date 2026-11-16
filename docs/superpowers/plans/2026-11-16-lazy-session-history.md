# Lazy Session History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Load twelve recent chat bubbles and fetch each older twelve-bubble page only on demand.

**Architecture:** Maintain indexed turn boundaries and coalesced replay inputs in the control database. Use an explicit history bootstrap/cursor contract separate from journal continuity, with immutable older pages and cached per-turn browser reduction.

**Tech Stack:** Bun, TypeScript, SQLite, Vue 3, existing Claude Agent SDK inspection RPC.

**Spec:** `docs/superpowers/specs/2026-11-16-lazy-session-history-design.md`

## Global Constraints

- Page size is 12 chat bubbles, not SDK rows or journal events.
- Durable journal rows, event identities, allocation, and runner ACKs are unchanged.
- Cursors are session-scoped, exclusive, and invalidated by conversation reset.
- Generated shadcn-vue files are never edited, lint-fixed, or formatted.
- No commit, push, deployment, service restart, or billed SDK query is authorized by implementation alone.

## Review Focus

- An assistant turn with thousands of deltas must keep complete text without thousands of browser events.
- A page starting at an assistant bubble must not invent a thirteenth user bubble.
- A stale older-page response after `/clear` must not restore the prior conversation.
- A reconnect before the initial bootstrap must request a bootstrap again, not full replay.
- An asynchronous prepend concurrent with live output must preserve the reader's anchor.

---

### Task 1: Indexed history inputs

**Files:** Create `packages/control-db/src/session-history.ts` and `.test.ts`; modify `db.ts`, `journal.ts`, `index.ts`, and protocol `index.ts`.

**Interfaces:** `readSessionHistory(db, sessionId, { before?, resetSequence? }): SessionHistoryPage`; `projectSessionHistory(db, event)` maintains compact turn inputs. `SessionHistoryPage` exposes ordered `turns`, `before`, `hasMore`, `resetSequence`, and `watermark`. Each `HistoryTurn` has a numeric cursor, kind, and compact event inputs.

- [x] Write failing tests for newest twelve bubbles, exclusive older pages, assistant-only page borders, reset invalidation, thousand-delta coalescing, tool boundaries, and unchanged durable counts.
- [x] Run `bun test packages/control-db/src/session-history.test.ts` and observe RED.
- [x] Add schema/backfill and transactional ingestion projection. Coalesce consecutive same-route deltas only; read at most thirteen turn headers and chunks for the twelve selected turns.
- [x] Run database tests and verify GREEN.

### Task 2: Explicit history bootstrap and paging

**Files:** Modify `browser-gateway.ts`, `browser-gateway.test.ts`, `server.ts`, protocol `index.ts`, and `session-stream.ts`/`.test.ts`.

**Interfaces:** Cold `subscribe` carries `history: true`; server sends `session.history` with `bootstrap: true`. `history.before` requests an exclusive older page using the current reset sequence. Bootstrap establishes continuity; older pages never move `through`.

- [x] Write failing tests proving one bounded cold history response, no raw replay on bootstrap, ownership checks, reset-stale page rejection, and backpressure stopping reads.
- [x] Run gateway/stream tests and observe RED.
- [x] Implement the explicit frames, client validation/dedup, reset handling, and reconnect behavior while retaining raw/journal compatibility.
- [x] Run gateway/stream tests and verify GREEN.

### Task 3: Lazy UI and SDK enrichment

**Files:** Modify session store, `SessionView.vue`, `EventJournal.vue`, `scroll.ts`, session-history controller/tests; create `paged-turns.ts`/`.test.ts`.

**Interfaces:** Store exposes `loadEarlierSession(): Promise<void>`. `EventJournal` receives indexed history inputs and an async `loadEarlier` callback. `derivePagedTurns` caches immutable settled turn reduction and reduces only changed turn inputs. SDK enrichment starts only when the subagent inspector opens; legacy controller remains reset/generation guarded.

- [x] Write failing tests for twelve-message page size, no cold SDK fetch, no implicit older-page request, single-flight loading, stale route/reset responses, and cached settled turns during live append.
- [x] Run relevant web tests and observe RED.
- [x] Wire history bootstrap, prepend anchoring, explicit SDK inspector enrichment, and cached turn rendering. Keep pending approvals visible and preserve optimistic/live output.
- [x] Run web tests and verify GREEN.

### Task 4: Integration and verification

**Files:** Modify real socket integration tests and architecture documentation.

- [x] Add a real database/socket regression for a long session: twelve initial bubbles, twelve more on demand, unchanged journal count, correct live/reconnect/reset behavior.
- [x] Run the integration test and confirm it catches missing history routing before completing that routing.
- [x] Document history bootstrap versus journal coverage and the deferred installed-SDK full-chain limitation.
- [x] Run `bun test`, `bun run typecheck`, `bun run lint`, and `git diff --check` with fresh output.
- [x] Inspect scope and generated-file protection; leave changes uncommitted on `fix/lazy-session-history`.

### Follow-up: harden all deferred issues

The user requested all previously deferred issues fixed. Evidence and decisions
are recorded in `.superpowers/sdd/2026-11-16-lazy-session-history/progress.md`.

- [x] Gate chat pagination with `workspace.sessions.chat-pages`; retain legacy offsets.
- [x] Validate complete history frames and SDK page metadata before state mutation.
- [x] Correlate malformed/forbidden older-history errors without an ownership oracle.
- [x] Add real DOM/CSS/Vue-unmount coverage with controlled geometry; release anchors on cancellation.
- [x] Version-gate transactional projection reconstruction and benchmark a synthetic 1M-event journal.
- [x] Keep older SDK cursors stable in bounded immutable snapshots; refuse expired or invalid cursors explicitly.
- [x] Run fresh full tests/typecheck/lint/diff-check: 2547/2547 tests, all gates exit 0.
- [x] Verify actual EventJournal/ScrollArea in BrowserOS with synthetic data: 30 real-layout checks, screenshot inspected.
- [ ] Complete one fresh read-only follow-up review (blocked by three provider API 524 timeouts; no active reviewer or verdict, automatic retries stopped).

BrowserOS reconnected and real-browser layout/lifecycle verification passed on
2026-11-16. The isolated loopback harness uses synthetic history and mounts the
actual SFC; it does not exercise a deployed control server or real SDK query.
No billed SDK query, deploy, service restart, commit or push is authorized by
this implementation.
