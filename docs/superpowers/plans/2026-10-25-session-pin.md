# Session Pin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An accepted dispatch pins its session to the (workspace, runner) it ran on; every later run of that session rides the pin instead of re-running placement, so an interactive session never splits across runners (§2.3 session routing, ADR-006).

**Architecture:** A new `sessions` table stores the pin, written by `Scheduler.dispatch` only after every refusal gate passes (pin-before-enqueue: a crash leaves a pinned session with no run, never the reverse). The dispatch route reads the pin first: foreign owner → 404, a body choice that differs from the pin → 409 `session_pinned`, a matching or absent choice → the pinned runner goes through the existing readiness-only branch with candidates skipped entirely (the pin is trusted; workspace-declaration drift must not brick a resume). First pin wins (`INSERT OR IGNORE`); re-pinning is §21.6 migration, out of scope.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, the existing test harness in `runs-routes.test.ts` (real handshake over a real socket).

**Non-goals:** re-pin / session migration (§21.6), `POST /api/workspaces/:id/sessions` (§17.1 future table API), `listSessions` rewrite onto the pin, UI pin display, session-id reuse across owners for *unpinned* sessions (pre-existing wrinkle, unchanged).

**Spec:** `docs/ARCHITECTURE.md` — §1.1 ("Không tự chuyển coding run chưa rõ trạng thái sang Runner khác"), §2.3 session routing row ("Pin session vào Runner + workspace"), ADR-006 (stateful pin, no load-balance resume, no auto-migrate), §17.1 (`sessions` table: workspace/runner pin), §21.6 (session migration — future, non-goal). The deferred decision point this implements is recorded in `docs/superpowers/plans/2026-10-25-run-api-placement-and-followups.md`.

## Global Constraints

- §8.1 option policy: an absent override is omitted, never a stand-in — a prompt-only rerun on a pinned session carries the pin's workspace in the dispatch payload, and a blank body `workspaceId` normalizes to `"default"` only for *new* sessions.
- First pin wins: `INSERT OR IGNORE`, the pin is never updated by a later dispatch. Re-pin = future migration milestone.
- 404 for another owner's pinned session — never 403/409, which would leak existence.
- `Cache-Control: no-store` stays on the 202 response; the prompt only ever travels in the body (§19.4).
- The `sessions` table has **no** `REFERENCES` clauses, mirroring `active_runs`/`run_events`: dispatch plumbing whose ids the route already validated (`workspaces`/`runner_credentials` carry FKs; event plumbing does not).
- `exactOptionalPropertyTypes: true` — conditional spreads, never `undefined` assigned to optional props.
- UI copy Vietnamese with domain nouns in English; code comments and test names in English; Tailwind utilities only.
- Never edit generated shadcn files (`apps/web/src/components/ui/**`); biome protection override stays LAST in the ignore list.
- Ledger `.superpowers/sdd/2026-10-25-session-pin/progress.md` is local-only, never committed.

## Review Focus

1. A prompt-only rerun of a session whose pin came from an explicit `workspaceId` dispatch must ride the pin's workspace in the run.start payload — today it would silently fall back to `"default"`. Pinned by Task 3 test (b).
2. A pinned runner that goes offline must answer 503 `runner_offline` and never fail over to another ready runner (ADR-006: no load-balance resume). Pinned by Task 3 test (f).
3. Another owner reusing the session id must get 404 with nothing enqueued — no existence leak, no dispatch. Pinned by Task 3 test (g).
4. A pinned session with a body that matches the pin (explicit `runnerId`/`workspaceId` equal to it) must stay 202 — equality is not a conflict. Pinned by Task 3 test (e).
5. A revoked pinned runner must refuse like an offline one, even though the pin's runner row no longer passes the legacy candidate query — the pinned path never queries candidates, so revocation needs its own check. Pinned by Task 3 test (k).

---

### Task 1: The sessions table and pin accessors

**Files:**
- Modify: `packages/control-db/src/db.ts` (migrate, after the `workspaces` table block)
- Create: `packages/control-db/src/sessions.ts`
- Modify: `packages/control-db/src/index.ts` (export the two functions and the type)
- Test: `packages/control-db/src/sessions.test.ts`

**Interfaces:**
- Consumes: `migrate(db)` (existing).
- Produces:
  - `export type SessionPin = { sessionId: string; ownerId: string; workspaceId: string; runnerId: string };`
  - `export function ensureSessionPin(db: Database, input: { sessionId: string; ownerId: string; workspaceId: string; runnerId: string }): void` — `INSERT OR IGNORE INTO sessions`; first pin wins.
  - `export function sessionPin(db: Database, sessionId: string): SessionPin | undefined` — `SELECT` by id; bun:sqlite `.query(sql).get(param)` binds the parameter; `null` maps to `undefined`.

- [ ] **Step 1: Write the failing test** (`packages/control-db/src/sessions.test.ts`)

```ts
test("the first pin for a session is stored", () => {
  // setup: :memory: db + migrate
  ensureSessionPin(db, { sessionId: "session-1", ownerId: "user-1", workspaceId: "ws", runnerId: "runner-a" });
  expect(sessionPin(db, "session-1")).toEqual({
    sessionId: "session-1", ownerId: "user-1", workspaceId: "ws", runnerId: "runner-a",
  });
});

test("the first pin wins — a later dispatch cannot move it", () => {
  ensureSessionPin(db, { sessionId: "session-1", ownerId: "user-1", workspaceId: "ws", runnerId: "runner-a" });
  ensureSessionPin(db, { sessionId: "session-1", ownerId: "user-1", workspaceId: "ws", runnerId: "runner-b" });
  expect(sessionPin(db, "session-1")?.runnerId).toBe("runner-a");
});

test("an unknown session has no pin", () => {
  expect(sessionPin(db, "nobody")).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails** — `bun test packages/control-db/src/sessions.test.ts` → FAIL (cannot find `./sessions.ts`).

- [ ] **Step 3: Implement.** In `db.ts` `migrate()`, after the `workspaces` block, with a comment stating the §2.3/ADR-006 semantics (one pin per session, first wins, written only on an accepted dispatch):

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  runner_id    TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
```

No `REFERENCES` (see Global Constraints). `sessions.ts` implements the two functions per Interfaces; `ensureSessionPin` uses `Date.now()` for `created_at`. Export all three from `index.ts`.

- [ ] **Step 4: Run tests** — `bun test packages/control-db/src/sessions.test.ts` → 3 PASS; then `bun test packages/control-db` → all green.

- [ ] **Step 5: Commit** — `git add packages/control-db/src/{db.ts,sessions.ts,sessions.test.ts,index.ts} && git commit -m "feat: add the sessions pin table and its accessors"`

### Task 2: Dispatch pins the session

**Files:**
- Modify: `packages/control-db/src/scheduler.ts` (`DispatchRequest`, `dispatch`)
- Test: `packages/control-db/src/scheduler.test.ts`

**Interfaces:**
- Consumes: `ensureSessionPin` from Task 1.
- Produces: `DispatchRequest` gains a required `ownerId: string` — every caller must pass it (the route passes `authorized.userId` in Task 3).

- [ ] **Step 1: Write the failing tests** (`scheduler.test.ts`). Add `ownerId: "user-1"` to the shared `request` const (compile error until the type changes — that is the RED). New tests:

```ts
test("an accepted dispatch pins the session", async () => {
  const { db, scheduler } = setup();
  await scheduler.dispatch(request, capacity());
  expect(
    db.query("SELECT owner_id, workspace_id, runner_id FROM sessions WHERE id = ?").get("session-1"),
  ).toEqual({ owner_id: "user-1", workspace_id: "workspace-1", runner_id: "runner-a" });
});

test("the pin outlives a dispatch on another runner", async () => {
  const { db, scheduler } = setup();
  await scheduler.dispatch(request, capacity());
  db.exec("DELETE FROM active_runs"); // free the session, as a terminal event would
  await scheduler.dispatch({ ...request, runId: "run-2", attemptId: "attempt-2" }, capacity({ runnerId: "runner-b" }));
  expect(db.query("SELECT runner_id FROM sessions WHERE id = ?").get("session-1"))
    .toEqual({ runner_id: "runner-a" });
});
```

- [ ] **Step 2: Run tests to verify they fail** — `bun test packages/control-db/src/scheduler.test.ts` → FAIL (pin rows missing).

- [ ] **Step 3: Implement.** `DispatchRequest` gains `ownerId: string` with a doc comment (§2.3: the pin records whose session it is, so another owner's reuse answers 404). In `dispatch`, after the last refusal gate (`session_busy`) and **before** `outbox.enqueue` (crash-consistency direction; comment it), call `ensureSessionPin(this.#db, { sessionId, ownerId, workspaceId, runnerId: capacity.runnerId })`.

- [ ] **Step 4: Run tests** — `bun test packages/control-db/src/scheduler.test.ts` → all green (existing tests only need the const's new field).

- [ ] **Step 5: Commit** — `git commit -m "feat: pin a session on its first accepted dispatch"`

### Task 3: The route honors the pin

**Files:**
- Modify: `apps/control-server/src/routes/runs-routes.ts` (`handleDispatchRun`)
- Modify: `apps/control-server/src/routes/runs-routes.test.ts` (`start` returns `auth`; `connectRunner` also returns its `link`; new describe block)
- Test: same file.

**Interfaces:**
- Consumes: `sessionPin` (Task 1); `DispatchRequest.ownerId` (Task 2).
- Produces: route behavior — 404 for a foreign owner's pinned session; 409 `session_pinned` for a body choice differing from the pin; pinned sessions skip candidate computation and use the existing readiness-only branch on `pin.runnerId`; dispatch call passes `ownerId: authorized.userId`.

- [ ] **Step 1: Write the failing tests.** New describe `"an existing session rides its pin"` at the end of the `POST /api/sessions/:id/runs` describe. Shared harness facts: `start()` returns `{ db, url, cookie, credential, auth }` (add `auth`); a second runner credential is minted like the existing foreign-owner test (`issueRunnerCredential(db, { id: "runner-b", ownerId: "user-1" })`); bodies with extra fields go through raw `fetch` mirroring the model tests. Tests:

  - **(a)** "a session's second run returns to its pinned runner, not the earliest ready one" — connect runner-b only; revoke runner-a (`UPDATE runners SET revoked_at = ?`); dispatch 1 → 202 `runner-b`; un-revoke runner-a; dispatch 2 prompt-only → today lands on runner-a (RED) — must be `runner-b`.
  - **(b)** "a prompt-only rerun rides the pinned workspace" — runner-a declares `[{ workspaceId: "ws", path: "/srv/a" }]`; dispatch 1 body `{ workspaceId: "ws" }` → 202; dispatch 2 prompt-only → 202; both inbox payloads carry `workspaceId: "ws"`; pin row `workspace_id = "ws"`.
  - **(c)** "a different workspace than the pin is refused with session_pinned" — setup like (b); dispatch 2 body `{ workspaceId: "other" }` → 409 `"session_pinned"`, inbox still holds exactly one command.
  - **(d)** "a different runner than the pin is refused with session_pinned" — two runners connected, no declarations; dispatch 1 → `runner-a`; dispatch 2 body `{ runnerId: "runner-b" }` → 409 `"session_pinned"`.
  - **(e)** "a body that matches the pin is accepted" — dispatch 2 body `{ runnerId: "runner-a", workspaceId: "default" }` → 202 `runner-a`.
  - **(f)** "an offline pinned runner is refused without failover" — connect runner-a and runner-b; dispatch 1 → `runner-a`; close runner-a's link (`waitFor` its `stateOf` to leave `ready`); dispatch 2 prompt-only → today 202 on `runner-b` (RED) — must be 503 `"runner_offline"`.
  - **(g)** "another owner's pin is invisible: 404, no dispatch" — insert `user-2` + mint `cookie2` via `auth.issueAccessToken("user-2")`; dispatch 1 as user-1 → 202; dispatch 2 with `cookie2`, same session id → 404; inbox holds one command.
  - **(h)** "a fresh session dispatches legacy and writes the pin" — dispatch 1 prompt-only → 202 `runner-a`; `sessions` row is `{ owner_id: "user-1", workspace_id: "default", runner_id: "runner-a" }`.
  - **(k)** "a revoked pinned runner is refused like an offline one" — dispatch 1 → `runner-a`; revoke runner-a; dispatch 2 prompt-only → 503 `"runner_offline"`.

- [ ] **Step 2: Run tests to verify they fail** — `bun test apps/control-server/src/routes/runs-routes.test.ts` → (a), (b), (f), (g), (k) FAIL with the described wrong outcomes; (c)/(d) FAIL with today's wrong statuses; (e)/(h) pass trivially but stay as regression pins.

- [ ] **Step 3: Implement in `handleDispatchRun`.** After the model validation and **before** the `runnerId` ownership block:
  1. `const pin = sessionPin(options.db, sessionId);`
  2. `if (pin !== undefined && pin.ownerId !== authorized.userId)` → `new Response("not found", { status: 404 })` (comment: no existence leak).
  3. Pin compatibility, on the **raw** body fields so absent/blank choices never conflict. First hoist the `runnerId` non-string 400 above these checks (the pinned path skips the ownership block, so the type check can no longer live there); then: body `workspaceId` is a non-empty string ≠ `pin.workspaceId`, or body `runnerId` ≠ `pin.runnerId` → `new Response("session_pinned", { status: 409 })`.
  4. When pinned: skip the runnerId ownership query and the candidates block entirely; set `runnerId = pin.runnerId` for the readiness branch; the dispatch payload's `workspaceId` is `pin.workspaceId` (not the normalized `"default"`). The pinned runner's row must still be un-revoked — one `SELECT revoked_at FROM runners WHERE id = ? AND owner_id = ?` → revoked/missing ⇒ 503 `runner_offline` (no failover, ADR-006).
  5. Unpinned: existing Task-12 logic unchanged.
  6. The `scheduler.dispatch` request gains `ownerId: authorized.userId`.

- [ ] **Step 4: Run tests** — `bun test apps/control-server/src/routes/runs-routes.test.ts` → all green, including the existing `session_busy` and release tests (prompt-only reruns are pin-compatible) and the workspace describe (single-dispatch sessions, nothing pinned).

- [ ] **Step 5: Commit** — `git commit -m "feat: dispatch existing sessions through their pin"`

### Task 4: The web surface disambiguates the new 409

**Files:**
- Modify: `apps/web/src/services/runs-api.ts` (409 branch, `StartRunResult`)
- Modify: `apps/web/src/components/Composer.vue` (failure toast branch)
- Test: `apps/web/src/services/runs-api.test.ts`

**Interfaces:**
- Consumes: 409 body `session_pinned` from Task 3.
- Produces: `StartRunResult` failure reason union gains `"session_pinned"`.

- [ ] **Step 1: Write the failing test** (`runs-api.test.ts`, mirroring the existing 409 stub): a stubbed 409 response with body `"session_pinned"` maps to `{ ok: false, reason: "session_pinned" }`; the existing `"session_busy"` stub stays green.

- [ ] **Step 2: Run to verify it fails** — `bun test apps/web/src/services/runs-api.test.ts` → FAIL (union lacks the reason).

- [ ] **Step 3: Implement.** `StartRunResult` reason union gains `"session_pinned"`; the 409 branch reads the body text (`await response.text()`, trimmed) and maps `"session_pinned"` to itself, anything else to `"session_busy"`. In `Composer.vue`, next to the `session_busy` branch: `session_pinned` → `toast.error("Phiên này đã ghim runner/workspace khác — không thể đổi giữa chừng.")`.

- [ ] **Step 4: Verify** — `bun test apps/web/src/services/runs-api.test.ts` PASS; `bun run typecheck` PASS; `cd apps/web && bun run build` PASS (SFCs are outside bun test's reach).

- [ ] **Step 5: Commit** — `git commit -m "feat: surface session_pinned refusals in the composer"`

### Task 5: Gates, ledger, push, review

- [ ] **Step 1: Full gates** — `bun test` (all packages; ≥ the current 596 + new tests), `bun run typecheck`, `bunx biome check .`, `cd apps/web && bun run build`. All green.
- [ ] **Step 2: Ledger** — append `.superpowers/sdd/2026-10-25-session-pin/progress.md` (local-only): task lines with commit hashes and test commands; rulings:
  - `Ruling: pinned sessions trust their pin — placement candidates and workspace declarations gate only NEW sessions; declaration drift never bricks a resume (ADR-006) — cost if wrong: a run may land on a runner that stopped serving the workspace, which §21.6 migration will own.`
  - `Ruling: 404 (not 403) for another owner's pinned session; unpinned session-id reuse across owners stays as today (pre-existing wrinkle, out of scope).`
  - `Ruling: no REFERENCES on sessions — dispatch plumbing like active_runs; ids validated upstream.`
- [ ] **Step 3: Commit plan doc + push** — `git add docs/superpowers/plans/2026-10-25-session-pin.md && git commit -m "docs: add the session pin plan"`; `git push origin main`.
- [ ] **Step 4: Fresh whole-branch review** — general-purpose subagent with the code-reviewer template, range = commit before Task 1 .. HEAD; act on findings (fix or ledger).
- [ ] **Step 5: Memory handoff + Vietnamese report.**
