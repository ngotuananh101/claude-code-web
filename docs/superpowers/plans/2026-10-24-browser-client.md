# Browser client (phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The first usable Vue client: login, see the owner's sessions, open one, and watch its §12.5 journal stream live.

**Architecture:** A `GET /api/sessions` read route on the control server backs the sidebar. The client is a Vite + Vue 3 app whose heart is a pure `session-stream.ts` state machine that applies `session.events` / `session.resync_required` frames (dedup by `sessionSequence`, gap → resubscribe, resync → rewind), tested with `bun test` like everything else. Components are thin renderers over that machine plus a socket singleton.

**Tech Stack:** Bun, TypeScript, Vue 3 + Vue Router (Pinia deferred), Vite, hand-rolled token CSS (Tailwind/shadcn deferred from §4.1), @fontsource Instrument Sans + IBM Plex Mono.

**Spec:** docs/ARCHITECTURE.md §4.1, §12.5, §16.1–16.2, §19.4; design pass per the frontend-design skill ("flight recorder" concept, recorded in the ledger).

## Global Constraints

- "The provider token must never reach the Control Server, the browser, the journal, or a log." (§19.4)
- "Never log the credential, and never log command payloads — they can contain prompt text (§19.4)."
- "Origin allowlist required before the browser WebSocket upgrade." (§19.4)
- Unknown/consumed/expired all answer the same status — no oracle (§19.4), including 401 on `/api/sessions`.
- No version pinning of dependencies (repo convention).
- Sentence-case labels everywhere; no ALL-CAPS tracked eyebrows; no `→` on links; honest empty states (frontend-design constraints).
- Markdown/payload rendering never injects raw HTML (§16.2). Phase 1 renders payloads as JSON text only.
- Socket service is a singleton, never per-component (§16.2).

## Review Focus

- Two attempts' events interleave in one session: the client must judge continuity by `sessionSequence`, never by arrival order or attempt — expect one contiguous journal, no false resync. (Pinned by Task 3 interleaved-batch test.)
- WS drops mid-stream: reconnect resubscribes from the client's own `through`; dedup makes the seam invisible. (Pinned by Task 3 resume-after-drop test.)
- An expired/revoked cookie on `/api/sessions`: 401, and the client lands on /login rather than an empty list. (Pinned by Task 1 bad-cookie test.)
- A minified one-line JSON payload must wrap inside the journal, never widen the gutter. (Visual pass, Task 5.)
- Empty state with zero sessions must say what to do next, not render a void. (Visual pass, Task 5.)

---

### Task 1: Backend — `/api/sessions` and a fixed dev port

**Files:**
- Modify: `apps/control-server/src/server.ts` (route + `handleListSessions`), `apps/control-server/src/websocket/server.test.ts`
- Modify: `apps/control-server/src/server.ts` `ServerOptions.port?: number`; `apps/control-server/src/index.ts` (`CC_WEB_PORT`, default 8787)
- Create: `scripts/seed-user.ts` (reads password from stdin, never argv — §19.4)
- Test: `apps/control-server/src/websocket/server.test.ts`

**Interfaces:**
- Consumes: `listSessions(db, ownerId): SessionSummary[]` from `@cc-web/control-db` (already exported, 13/13 passing).
- Produces: `GET /api/sessions` → `200 {"sessions": SessionSummary[]}` with `Cache-Control: no-store`; 401 without/with-bad cookie; 403 foreign origin. `ServerOptions.port` honored by `createServer`.

- [ ] **Step 1: Write the failing tests** — in `server.test.ts`:
  - "the sessions list answers the owner's sessions": seed runner owned by user-1, `ingestEvent` one event, `GET /api/sessions` with `Origin` + `Cookie` → 200, `body.sessions[0]` matches `{sessionId, watermark: 1, lastEventType, live: false}`; response carries `Cache-Control: no-store`.
  - "the sessions list needs the session cookie": no cookie → 401; cookie `cc_session=nonsense` → 401; foreign origin → 403.
- [ ] **Step 2: Run** `bun test apps/control-server/src/websocket/server.test.ts` — Expected: new tests FAIL (404 today), existing pass.
- [ ] **Step 3: Implement** `handleListSessions` (same shape as `handleCreateEnrollment`: Origin check → `browserGateway.authorize` → `listSessions(options.db, authorized.userId)` → `Response.json({sessions}, {headers: {"Cache-Control": "no-store"}})`) and the route.
- [ ] **Step 4: Run** — Expected: PASS, all existing pass.
- [ ] **Step 5: Failing test for the port**: `createServer({...})` with `port: 8944` exposes `handle.server.port === 8944`. Run RED, then implement (`port: options.port ?? 0`), GREEN. Entrypoint: `CC_WEB_PORT ?? 8787`.
- [ ] **Step 6: `scripts/seed-user.ts`** — `bun scripts/seed-user.ts <username>` reads the password from stdin via `Bun.console`/readline, stores `hashPassword(...)` (from `apps/control-server/src/auth/password.ts`) into `users`. No test (operator script; throws when stdin is a TTY? no — just document). Smoke-run it once against a temp DB.
- [ ] **Step 7: Commit** — `feat: serve the owner's session list over http`

### Task 2: Scaffold apps/web

**Files:**
- Modify: `apps/web/package.json`, root `tsconfig.json` (exclude `apps/web`), root `package.json` (`typecheck` gains `&& tsc -p apps/web --noEmit`)
- Create: `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/env.d.ts`, `apps/web/src/main.ts`, `apps/web/src/App.vue` (placeholder)

**Interfaces:**
- Produces: runnable `bun run dev` in `apps/web` proxying `/auth`, `/api`, `/ws/browser` (ws) → `http://127.0.0.1:8787`; `*.vue` shim so root tooling and `tsc -p apps/web` both pass.

- [ ] **Step 1:** deps: `vue`, `vue-router`, `@fontsource/instrument-sans`, `@fontsource/ibm-plex-mono`; dev: `vite`, `@vitejs/plugin-vue`, `typescript`, `vue-tsc` not needed (tsc suffices with the shim). Scripts: `dev`, `build` (`vite build`).
- [ ] **Step 2:** `apps/web/tsconfig.json` extends `../../tsconfig.base.json`; `lib: ["ES2023", "DOM", "DOM.Iterable"]`, `types: ["vite/client"]`, redeclare `paths` with `../../packages/...` targets.
- [ ] **Step 3:** root tsconfig excludes `apps/web`; typecheck script chained. Vite config with proxy. `env.d.ts`: `vite/client` reference + `declare module "*.vue"`.
- [ ] **Step 4:** Verify: `bun install`; `bun run typecheck` (root+web); `cd apps/web && bun run build` → dist emitted.
- [ ] **Step 5: Commit** — `feat: scaffold the web client`

### Task 3: `session-stream.ts` state machine (TDD)

**Files:**
- Create: `apps/web/src/services/session-stream.ts`, `apps/web/src/services/session-stream.test.ts`

**Interfaces:**
- Consumes: `SessionEventsFrame`, `SessionResyncFrame` types from `@cc-web/protocol`.
- Produces: `createSessionStream({send(frame: unknown): void})` → `{ apply(frame): void, state(): SessionStreamState }` where state = `{through, events: BrowserReplayEvent[], live: boolean | null, needsResync: boolean}`; pure — no Vue, no DOM.

- [ ] **Step 1: Write failing tests** (bun test):
  - applies a replay batch: events appended in order, `through` advances to the batch's last `sessionSequence`, `live` taken from the frame.
  - dedups by `sessionSequence`: re-delivered events (seq ≤ through) are ignored even when they arrive again.
  - a gap (first event seq > through+1) triggers exactly one `send({type:"subscribe", sessionId, afterSessionSequence: through})`.
  - `session.resync_required {fromSequence}` triggers one subscribe from `fromSequence` and clears previously held events (they are outside retention).
  - two attempts interleaved (batches carrying mixed `attemptId`s but contiguous session sequences) produce one contiguous journal with no resubscribe.
  - resume-after-drop: state holds `through`; feeding the batch the server replays from an older offset dedups and keeps one contiguous list.
- [ ] **Step 2: Run RED** `bun test apps/web/src/services/session-stream.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the machine. Send is injected; the machine never opens sockets.
- [ ] **Step 4: Run GREEN**, then full `bun test`.
- [ ] **Step 5: Commit** — `feat: replay state machine for the browser session stream`

### Task 4: Views, components, styles

**Files:**
- Create: `src/router.ts`, `src/stores/sessions.ts` (reactive singleton; Pinia deferred — ledger ruling), `src/services/socket.ts` (WS singleton: connect `/ws/browser`, feed frames into `session-stream`), `src/views/LoginView.vue`, `src/views/SessionView.vue`, components `SessionRail.vue`, `ConnectionChip.vue`, `EventJournal.vue`, `Composer.vue`, `styles/tokens.css`, `styles/app.css`
- Modify: `src/main.ts`, `src/App.vue`

**Interfaces:**
- Consumes: Task 2 scaffold; Task 3 machine; `GET /api/sessions`; `POST /auth/login`; `BrowserReplayEvent` type.
- Produces: routes `/login` and `/`; store API `loadSessions()`, `openSession(id)`, `connection: "connecting"|"live"|"closed"`.

- [ ] **Step 1:** tokens.css — palette paper `#FAFAF7`, ink `#1A211E`, line `#E3E6E0`, pine `#106B57`, amber `#9A6700`, mute `#6B7570`; Instrument Sans for prose, IBM Plex Mono for sequence numbers/event types/payloads; the two voices never mix in one line.
- [ ] **Step 2:** router with a guard: probe `GET /api/sessions`; 401 → `/login`. LoginView posts `/auth/login`, shows one inline error, never logs the password.
- [ ] **Step 3:** store + socket singleton; `openSession` sends `subscribe {sessionId, afterSessionSequence: through ?? 0}`, machine's send-gap/resync flows through the same socket; store renders machine state.
- [ ] **Step 4:** EventJournal — left rail 264px; session header (id, watermark, live dot — one quiet pulse); numbered gutter (mono, right-aligned), run-grouped headers by `runId`; payload as pretty JSON in mono; honest empty state ("No sessions yet — enroll a runner and dispatch a run."); Composer disabled stub with copy that says why ("Sending prompts arrives with the dispatch API — not wired yet.").
- [ ] **Step 5:** build + typecheck + lint green.
- [ ] **Step 6: Commit** — `feat: the session journal interface`

### Task 5: Verify, visual pass, ship

- [ ] **Step 1:** `bun test` (full), `bun run typecheck`, `bun run lint`, `bun run test:integration` (7 probes, unchanged).
- [ ] **Step 2:** Visual pass with the browser-use skill: start control server (CC_WEB_PORT=8787, allowed origin http://localhost:5173) + seeded user + seeded demo session; `bun run dev`; login, open the session, confirm journal/gutter/live-dot/empty-state against the design intent; fix what reads wrong.
- [ ] **Step 3:** Update `docs/phase1-results.md` + README row. Commit, push to main.
