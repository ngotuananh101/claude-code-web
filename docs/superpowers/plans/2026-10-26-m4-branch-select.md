# M4 — Branch Select, Real: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The composer's branch select offers each project's real local branches, and the runner enforces the choice at run start — switching only when the tree is provably clean, refusing with an actionable reason otherwise.

**Architecture:** Branches ride the workspace declaration (hello/reconcile → `workspaces` table → `GET /api/workspaces`); the dispatch route validates the choice against declarations and carries it in the `run.start` payload; the runner runs a checkout gate under the workspace lock, injected into the executor as a seam like `sdk`.

**Tech Stack:** Bun + TypeScript, `bun:test`, Bun.spawn/spawnSync (argv arrays only), SQLite, Vue 3 (template-only changes, verified by build).

**Spec:** `docs/superpowers/specs/2026-10-26-branch-select-design.md` — the rulings travel with this plan; executors read both.

## Global Constraints

- §15.2/§15.5: git only ever runs through argv arrays with `cwd` set — no shell, no string interpolation; never `reset`/`clean`/`stash`/`checkout -f`/`checkout -- .`/`-b`/`--track`.
- "Branch" = a local head (`refs/heads/`) — never tags, never `origin/*`, never DWIM creation.
- Branch name shape everywhere (route, gate, caps): `^[A-Za-z0-9][A-Za-z0-9._/-]*$`, length 1–256.
- Declaration caps: >200 entries keep the first 200; entries >256 chars are malformed (protocol) / dropped (lister); duplicates keep the first occurrence.
- Refusal reasons are exactly: `invalid_branch_name`, `dirty_tree`, `unknown_branch`, `checkout_failed`.
- No branch in payload → zero git spawns (current behavior byte for byte).
- §19.4: never log credentials or command payloads; branch names in events/journal are fine (operator-visible data).
- VN UI copy, English domain nouns; code comments/tests in English; TDD RED→GREEN per task; generated `apps/web/src/components/ui/**` never hand-edited.
- Bun sqlite binds with `.query(sql).get(param)`; bun test cannot compile SFCs (behavior in pure modules, template by build).

## Review Focus

1. A workspace that is not a git repo (or git binary missing) must not break hello — it declares zero branches. → Task 2 test "a failing git lists no branches".
2. A `branch` payload value that is not a non-empty string must behave as absent on the runner, behind the route's validation. → Task 4 test "a non-string or empty branch payload is absent".
3. A tree with only untracked files (`?? ` lines alone) is NOT dirty — checkout proceeds. → Task 3 test "untracked-only porcelain output is not dirty".
4. `branch` in the body without a real `workspaceId` is a 400, never silently ignored. → Task 7 test "a branch without a workspace is a bad request".
5. A wedged git process (timeout) refuses `checkout_failed` and releases the workspace lock. → Task 3 test "a hung checkout times out into checkout_failed" + Task 4's refused path releasing the lock.

---

### Task 1: Protocol — `branches` on declared workspaces

**Files:**
- Modify: `packages/protocol/src/reconcile.ts`
- Test: `packages/protocol/src/reconcile.test.ts`

**Interfaces:**
- Produces: `DeclaredWorkspace = { workspaceId: string; path: string; branches?: string[] }` and `parseDeclaredWorkspaces` honoring it (consumed by Tasks 2, 5, 6, 7 and the runner gateway unchanged).

- [ ] **Step 1: Write the failing tests** (append to the existing parseDeclaredWorkspaces block)

Tests: absent field → result entries have no `branches` property; `[]` → empty array; `["main","dev"]` → both; a non-array value → `undefined` (malformed); an entry that is `""`/non-string → `undefined`; an entry of 257 chars → `undefined`; 250 entries → exactly the first 200; `["a","b","a"]` → `["a","b"]`.

- [ ] **Step 2: Run to verify RED** — `bun test packages/protocol/src/reconcile.test.ts` (fails: branches not parsed)

- [ ] **Step 3: Implement** — add `branches?: string[]` to `DeclaredWorkspace`; in `parseDeclaredWorkspaces`, when `record["branches"]` is `undefined` leave the property absent; otherwise require an array of non-empty strings ≤256 chars (else return `undefined`), keep the first 200, dedupe first-wins, attach to the workspace entry.

- [ ] **Step 4: Run to verify GREEN** — same command, all pass. Then `bun test packages/protocol` — the whole package stays green (handshake tests that feed workspaces still parse).

- [ ] **Step 5: Commit** — `feat(protocol): branches on declared workspaces`

### Task 2: Runner git kit — bounded spawner + sync lister

**Files:**
- Create: `apps/runner/src/git/spawn.ts`, `apps/runner/src/git/branches.ts`
- Test: `apps/runner/src/git/spawn.test.ts`, `apps/runner/src/git/branches.test.ts`

**Interfaces:**
- Produces:
  - `type GitSpawn = (argv: readonly string[], cwd: string) => Promise<{ exitCode: number; stdout: string }>` (spawn.ts)
  - `gitSpawn(argv, cwd, timeoutMs = 10_000): Promise<{exitCode; stdout}>` — runs Bun.spawn with `stdout: "pipe"`, kills at the timeout, a killed/timed-out process reports a non-zero exitCode (spawn.ts)
  - `listBranches(path: string): string[]` — sync; `refs/heads/` names only, caps per Global Constraints, failure → `[]` (branches.ts; consumed by Task 5's bootstrap)

- [ ] **Step 1: Write the failing tests**

spawn.test.ts (uses real processes, tmp cwd):
- `["git","--version"]` in `"/"` → exitCode 0, stdout contains "git version".
- `["sleep","5"]` with `timeoutMs: 100` → resolves non-zero well under 5s (assert elapsed < 2000ms).
- a non-existent command (`["definitely-not-a-bin","x"]`) → non-zero exitCode, does not throw.

branches.test.ts (real git on a tmp repo: `git init`, config user, one commit, `git branch dev`):
- lists `["dev","main"]`-shape output (assert contains both, order irrelevant).
- a path that is not a repo (`mkdtemp`) → `[]`.
- caps: feed a fake by testing the pure parse? No — pin caps through the exported `parseBranchLines(lines: string[]): string[]` helper the lister uses: 250 lines → 200; a 257-char line dropped; duplicates deduped. (Export it for the test; it is the lister's parse half.)

- [ ] **Step 2: Run to verify RED** — `bun test apps/runner/src/git/` (files not importable yet)

- [ ] **Step 3: Implement** — spawn.ts: Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" }), await `exited`, read stdout, race a `setTimeout(timeoutMs)` that `proc.kill()`s; reject never — errors become `{ exitCode: 1, stdout: "" }`. branches.ts: `Bun.spawnSync(["git","for-each-ref","--format=%(refname:short)","refs/heads"], { cwd: path, stdout: "pipe", timeout: 10_000 })`; exit ≠ 0 → `[]`; else `parseBranchLines(stdout.split("\n"))` dropping empties.

- [ ] **Step 4: Run to verify GREEN** — `bun test apps/runner/src/git/`

- [ ] **Step 5: Commit** — `feat(runner): bounded git spawner and branch lister`

### Task 3: The checkout gate

**Files:**
- Create: `apps/runner/src/git/checkout.ts`
- Test: `apps/runner/src/git/checkout.test.ts`
- Modify: `apps/runner/src/execution/executor.ts` — only to export the result type named below (Task 4 adds the seam)

**Interfaces:**
- Consumes: `GitSpawn` from Task 2.
- Produces (both as exported types in `apps/runner/src/execution/executor.ts` — Task 3 adds ONLY these two type declarations to that file; the executor's behavior comes in Task 4; `checkout.ts` imports them, so the dependency arrow stays "the gate satisfies the executor's contract"):
  - `type BranchRefusal = "invalid_branch_name" | "dirty_tree" | "unknown_branch" | "checkout_failed"`
  - `type PrepareWorkspaceResult = { kind: "ready"; checkedOut: boolean; branch?: string } | { kind: "refused"; reason: BranchRefusal; branch?: string }`
  - and in `checkout.ts`: `prepareBranch(cwd: string, branch: string | undefined, spawn: GitSpawn): Promise<PrepareWorkspaceResult>` — `undefined` branch → `{ kind: "ready", checkedOut: false }` with ZERO spawns.

- [ ] **Step 1: Write the failing tests**

Unit tests with a fake `GitSpawn` scripted per argv (asserting the exact argv arrays — the §15.2 pin):
- no branch → ready/not-checked-out, fake records zero calls.
- `-x` / 300-char / `..`-containing names → refused `invalid_branch_name`, zero spawns.
- porcelain stdout `" M a.txt"` → refused `dirty_tree`, no rev-parse call.
- porcelain stdout `"?? new.txt"` only → proceeds; rev-parse exit 0; checkout exit 0 → ready/checkedOut with branch.
- porcelain exit 1 → refused `checkout_failed` (git itself broken — a non-repo).
- rev-parse exit 1 → refused `unknown_branch`, no checkout call.
- checkout exit 1 → refused `checkout_failed`.
- argv pins: rev-parse call is `["git","rev-parse","--verify","--quiet","refs/heads/<name>"]`, checkout is `["git","checkout","<name>"]`.

Real-git integration tests (tmp repo, real `gitSpawn`):
- clean repo on `main` with existing `dev` → `{kind:"ready",checkedOut:true,branch:"dev"}` and `git rev-parse --abbrev-ref HEAD` now prints `dev`.
- one tracked modification → refused `dirty_tree` and HEAD still `main`.

- [ ] **Step 2: Run to verify RED** — `bun test apps/runner/src/git/checkout.test.ts`

- [ ] **Step 3: Implement** — gate in the design's order: shape regex/length → `git status --porcelain` (tracked-dirty = any line not starting `?? `; non-zero exit → `checkout_failed`) → `git rev-parse --verify --quiet refs/heads/<name>` (non-zero → `unknown_branch`) → `git checkout <name>` (non-zero → `checkout_failed`). Refusals carry `branch` when a name was given.

- [ ] **Step 4: Run to verify GREEN** — `bun test apps/runner/src/git/`

- [ ] **Step 5: Commit** — `feat(runner): branch checkout gate with refusal reasons`

### Task 4: Executor — the `prepareWorkspace` seam

**Files:**
- Modify: `apps/runner/src/execution/executor.ts`
- Test: `apps/runner/src/execution/executor.test.ts`

**Interfaces:**
- Consumes: `PrepareWorkspaceResult` from Task 3 (the types already live in this file; Task 4 adds only behavior).
- Produces: `ExecuteOptions.prepareWorkspace?: (workspacePath: string, branch: string | undefined) => Promise<PrepareWorkspaceResult>`; payload parsing `branch` like `model` (non-empty string else undefined).

- [ ] **Step 1: Write the failing tests** (extend the existing fake-sdk harness)

- payload `{prompt:"p", branch:"dev"}` + prepare refused `dirty_tree` → events are exactly `run.started`, `run.failed` with payload `{error:"branch_refused", reason:"dirty_tree", branch:"dev"}`; the fake sdk is NEVER called; the attempt ends `failed` and the workspace lock is released (a second attempt on the same workspace begins).
- payload + prepare ready/checkedOut `dev` → events start `run.started`, `run.status` `{action:"checkout", branch:"dev"}`, then the sdk stream's own events; attempt ends `finished` on a finishing stream.
- payload `{prompt:"p", branch:""}` → prepare receives `undefined`; with prepare absent from options entirely, behavior is byte-identical to today (existing tests already pin this — they must stay green untouched).
- payload branch non-string (`42`) → prepare receives `undefined`.

- [ ] **Step 2: Run to verify RED** — `bun test apps/runner/src/execution/executor.test.ts`

- [ ] **Step 3: Implement** — parse `branch` beside `model`; after `run.started` (and before the router/stream), call `options.prepareWorkspace?.(options.workspacePath, branch)` when defined; refused → set `state="failed"`, `terminalWritten=true`, append the `run.failed` payload above, `return { state: "failed" }` (the existing `finally` finishes + releases); ready+checkedOut → append the `run.status` row; ready without checkout → nothing.

- [ ] **Step 4: Run to verify GREEN** — `bun test apps/runner/src/execution/`

- [ ] **Step 5: Commit** — `feat(runner): workspace preparation seam in the executor`

### Task 5: Wiring — controller, daemon, reconnect, bootstrap

**Files:**
- Modify: `apps/runner/src/execution/run-controller.ts`, `apps/runner/src/daemon.ts`, `apps/runner/src/connection/reconnect-loop.ts`, `apps/runner/src/bootstrap/main.ts`
- Test: `apps/runner/src/execution/run-controller.test.ts`, `apps/runner/src/daemon.test.ts`, `apps/runner/src/connection/reconnect-loop.test.ts`

**Interfaces:**
- Consumes: `prepareBranch`/`gitSpawn` (Tasks 2–3), `listBranches` (Task 2), `DeclaredWorkspace.branches` (Task 1).
- Produces:
  - `ControllerOptions.prepareWorkspace?: ExecuteOptions["prepareWorkspace"]` threaded into `executeRun`.
  - `DaemonOptions.declaredWorkspaces?: DeclaredWorkspace[] | (() => DeclaredWorkspace[])` — resolved each time a hello is built; `ReconnectLoopOptions.workspaces` accepts the same union, resolved when each reconcile frame is sent.
  - bootstrap wires `prepareWorkspace` to `(path, branch) => prepareBranch(path, branch, gitSpawn)` and builds the declaration thunk: `declaredWorkspaces(env)` each entry enriched with `branches: listBranches(path)`.

- [ ] **Step 1: Write the failing tests**

- run-controller: a command whose payload carries `branch:"dev"` reaches the injected fake prepare with the resolved workspace path and `"dev"`; refused prepare → attempt row `failed`, lock released (controller-level, one level above Task 4).
- daemon: `helloFrame` with a thunk whose array CHANGES between two calls returns the second call's branches (reconnect refresh); a plain array still works (back-compat).
- reconnect-loop: reconcile frame carries a thunk's current array at send time.

- [ ] **Step 2: Run to verify RED**

- [ ] **Step 3: Implement** — thread the option; accept-and-resolve the unions at both frame-build sites (a tiny `resolveDeclared()` helper per file, `typeof x === "function" ? x() : x`); bootstrap builds the enriched thunk (sync — `listBranches` is spawnSync-based).

- [ ] **Step 4: Run to verify GREEN** — `bun test apps/runner` (whole app).

- [ ] **Step 5: Commit** — `feat(runner): wire branch declarations and the checkout gate`

### Task 6: Control DB — store and serve branches

**Files:**
- Modify: `packages/control-db/src/db.ts`, `packages/control-db/src/workspaces.ts`
- Test: `packages/control-db/src/db.test.ts`, `packages/control-db/src/workspaces.test.ts`

**Interfaces:**
- Consumes: `DeclaredWorkspace.branches` (Task 1) via the gateway's existing `upsertRunnerWorkspaces` call.
- Produces: `DeclaredWorkspaceRow.branches?: string[]`; `OwnerWorkspace.branches: string[]` on `workspacesForOwner`.

- [ ] **Step 1: Write the failing tests**

- migration: a database created by the PREVIOUS schema (simulate by dropping the column logic order — practically: open db, run migrate, `PRAGMA table_info(workspaces)` includes `branches`; and a second migrate call is a no-op).
- roundtrip: upsert `{workspaceId:"default", path:"/w", branches:["main","dev"]}` → `workspacesForOwner` returns them in order; upsert without `branches` → `[]`; a row whose stored JSON is garbage (hand-written via raw SQL) reads as `[]`, never throws.
- replace semantics: re-upsert with different branches replaces wholesale (no accumulation).

- [ ] **Step 2: Run to verify RED**

- [ ] **Step 3: Implement** — `branches TEXT NOT NULL DEFAULT '[]'` in CREATE TABLE + `addColumnIfMissing(db, "workspaces", "branches", "TEXT NOT NULL DEFAULT '[]'")`; upsert stringifies `workspace.branches ?? []`; read parses with a try/catch default `[]` (and guards non-array results to `[]`).

- [ ] **Step 4: Run to verify GREEN** — `bun test packages/control-db`

- [ ] **Step 5: Commit** — `feat(control-db): branches on declared workspace rows`

### Task 7: Dispatch route + scheduler — validate, narrow, carry

**Files:**
- Modify: `apps/control-server/src/routes/runs-routes.ts`, `packages/control-db/src/scheduler.ts`
- Test: `apps/control-server/src/routes/runs-routes.test.ts`, `packages/control-db/src/scheduler.test.ts`

**Interfaces:**
- Consumes: `workspacesForOwner` with branches (Task 6), `MODEL_IDS`-style strict validation idiom.
- Produces: `DispatchRequest.branch?: string` riding the payload as `...(branch === undefined ? {} : { branch })`; route refusals `400 bad request` (shape, branch-without-workspace) and `400 unknown_branch`.

- [ ] **Step 1: Write the failing tests**

scheduler.test.ts: a dispatch with `branch:"dev"` enqueues a `run.start` whose payload carries `branch:"dev"`; without branch, the payload has no `branch` key (exact-shape assertion).

runs-routes.test.ts (existing server harness; `connectRunner` already accepts workspaces — extend its option with `branches`):
- branch `"..evil"` or 300 chars or non-string → 400.
- branch without a (non-blank) `workspaceId` → 400.
- two ready runners declaring workspace `default`, only the second declaring branch `dev` → dispatch with branch lands on the SECOND runner (placement narrows); without branch, first-wins order unchanged (existing test pins it).
- branch nobody declares → 400 `unknown_branch`; unknown workspace still → 400 `unknown_workspace` (checked first).
- explicit `runnerId` whose runner declares the workspace but not the branch → 400 `unknown_branch`.
- pinned session: dispatch with branch the pinned runner declares → 202; branch it does not declare → 400 `unknown_branch`.
- accepted dispatch → 202 and the delivered `run.start` frame's payload includes `branch` (harness already captures frames).

- [ ] **Step 2: Run to verify RED**

- [ ] **Step 3: Implement** — route: parse/validate branch (Global Constraints shape); require a named workspaceId when branch present; candidate narrowing via `workspacesForOwner(db, userId)` filtered by workspaceId (then `unknown_workspace`), then by `branches.includes(branch)` (then `unknown_branch`), preserving runner `created_at` order; pinned branch check against the pinned runner's declaration row; pass `branch` into `scheduler.dispatch`. Scheduler: type + payload spread only.

- [ ] **Step 4: Run to verify GREEN** — `bun test packages/control-db apps/control-server`

- [ ] **Step 5: Commit** — `feat(control): branch-aware dispatch validation and placement`

### Task 8: Web — real branch options in the composer

**Files:**
- Modify: `apps/web/src/services/workspaces-api.ts`, `apps/web/src/components/Composer.vue`

**Interfaces:**
- Consumes: `OwnerWorkspace.branches` from Task 6's API shape.
- Produces: no new module surface — template + local state only.

- [ ] **Step 1: Update the type** — `OwnerWorkspace` gains `branches: string[]`.

- [ ] **Step 2: Update the composer** — `branch` ref defaults `"current"`; `ProjectOption` carries `branches: string[]`; the select renders `SelectItem value="current"` labeled "Hiện tại" plus one mono item per declared branch; a watch resets `branch` to `"current"` when the project changes to one that does not declare the current choice; `send()` adds `body.branch` only when `branch.value !== "current"` AND `selectedProject.runnerId !== undefined` (the same condition under which `workspaceId` travels). The hardcoded `main` item is deleted. Comment updates: "stays local until the branch surface exists" is now false — rewrite it.

- [ ] **Step 3: Verify by build** — `bun run build` in apps/web (type + template gate; no unit — SFCs don't compile under bun test). `bunx vue-tsc --noEmit` if the repo's gate uses it — follow whatever `package.json` scripts exist.

- [ ] **Step 4: Commit** — `feat(web): real branch options in the composer`

### Task 9: Gates, review, push

- [ ] **Step 1: Full gates** — `bun test` (repo root), `bun run build` (web), lint/format per repo scripts (biome). All green.
- [ ] **Step 2: Whole-branch review** — fresh general-purpose reviewer over the diff since the M3 tag (`c9351d9`), re-grade findings by effect; Critical/Important → ONE RED→GREEN fix pass; Minor → ledger.
- [ ] **Step 3: Ledger + push** — write `.superpowers/sdd/2026-10-26-m4-branch-select/progress.md` (local-only), push to `main`, update the handoff memory.
