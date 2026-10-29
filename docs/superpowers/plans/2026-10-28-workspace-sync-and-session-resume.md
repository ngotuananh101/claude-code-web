# Workspace Discovery, Directory Browser & Session Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable automatic discovery of existing Claude Code workspaces on runners, directory browsing on runner hosts, Claude Code session enumeration, session resumption, and historical conversation replay in the web UI.

**Architecture:**
- Runner scans `~/.claude/projects` and persistent custom workspaces on boot/reconcile, advertising all available workspaces with git branches to the control server.
- Runner implements RPC commands `workspace.fs.browse`, `workspace.sessions.list`, and `workspace.sessions.messages` via dedicated handlers.
- Control server exposes REST endpoints backed by the existing `submitRpc` spine with 15s outbox/10s timeout guarantees.
- Control server dispatches `resumeSessionId` in `run.start` payloads; runner executor attaches directly to the existing Claude Code session.
- Web UI provides a directory browser modal, session picker in the composer, and historical message rendering in the conversation journal.

**Tech Stack:** Bun, TypeScript, Vue 3, Tailwind CSS, `@anthropic-ai/claude-agent-sdk`, SQLite (`bun:sqlite`), `@cc-web/protocol`.

**Spec:** `docs/superpowers/specs/2026-10-28-workspace-discovery-and-session-resume-design.md`

## Global Constraints

- Never hand-edit, reformat, or lint-fix generated shadcn-vue files (`apps/web/src/components/ui/**`, `apps/web/src/lib/utils.ts`, `apps/web/src/styles/index.css`, `apps/web/components.json`).
- Biome check override for generated files must remain last in `biome.json`.
- Do not commit `.superpowers/`, `design.md`, `TODO.md`, or `/tmp` files.
- All technical documentation, identifiers, commit messages, and PRs in English.
- No `git reset --hard` or `git clean` under any circumstance.
- Theme tokens must use standard shadcn theme variables (`var(--primary)`, `var(--muted-foreground)`, `var(--border)`, etc.) or Tailwind classes.
- Quality gates: `bun test`, `bun run typecheck`, `bun run lint`, `cd apps/web && bun run build`.

## Review Focus

1. **Path traversal & escaping in directory browser**: Attempts to pass `../../` or malicious paths must resolve cleanly using `path.resolve` and reject inaccessible directories with friendly errors.
2. **Missing or non-git folders**: Browsing a non-git directory or listing sessions in a folder with zero Claude history must return empty arrays cleanly without crashing or throwing 500s.
3. **Empty / non-existent session IDs**: Resuming a session ID that has no local JSONL transcript on the runner must fail fast with a descriptive refusal rather than hanging the SDK.
4. **Stale workspace synchronization**: Reconnects must re-evaluate declared workspaces and local git branches dynamically without duplicating entries.
5. **Historical message format compatibility**: Replayed messages from Claude Agent SDK must map faithfully into the chat view without breaking markdown rendering or tool result blocks.

---

### Task 1: Protocol & Wire Definitions

**Files:**
- Modify: `packages/protocol/src/inspection.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/inspection.test.ts`

**Interfaces:**
- Produces: `BROWSE_CAPABILITY = "workspace.browse"`, `SESSIONS_CAPABILITY = "workspace.sessions"`, `FsBrowseRequest`, `FsBrowseResult`, `SessionsListRequest`, `SessionsListResult`, `SessionMessagesRequest`, `SessionMessagesResult`, `parseBrowseRequest`, `parseSessionsRequest`.

- [ ] **Step 1: Write failing tests in `packages/protocol/src/inspection.test.ts`**
  Add unit tests validating `parseBrowseRequest` and `parseSessionsRequest` with valid, empty, and malformed payloads.

- [ ] **Step 2: Run test to verify it fails**
  Run: `bun test packages/protocol/src/inspection.test.ts`
  Expected: FAIL (types / functions undefined)

- [ ] **Step 3: Implement types and parsers in `packages/protocol/src/inspection.ts` and export from `packages/protocol/src/index.ts`**
  Define request and result types:
  ```ts
  export const BROWSE_CAPABILITY = "workspace.browse" as const;
  export const SESSIONS_CAPABILITY = "workspace.sessions" as const;
  ```
  Implement `parseBrowseRequest` and `parseSessionsRequest` following the exact idiom of `parseInspectRequest`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `bun test packages/protocol/src/inspection.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add packages/protocol/
  git commit -m "feat(protocol): define directory browse and session inspect wire types"
  ```

---

### Task 2: Runner DB Storage for Custom Workspaces

**Files:**
- Modify: `packages/runner-db/src/db.ts`
- Create: `packages/runner-db/src/workspaces.ts`
- Modify: `packages/runner-db/src/index.ts`
- Test: `packages/runner-db/src/workspaces.test.ts`

**Interfaces:**
- Produces: `addCustomWorkspace(db: Database, workspace: { workspaceId: string; path: string }, now?: number): void`, `listCustomWorkspaces(db: Database): Array<{ workspaceId: string; path: string; addedAt: number }>`

- [ ] **Step 1: Write failing tests in `packages/runner-db/src/workspaces.test.ts`**
  Test inserting custom workspaces, deduplication, and listing in `runner.db`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `bun test packages/runner-db/src/workspaces.test.ts`
  Expected: FAIL

- [ ] **Step 3: Add schema migration in `packages/runner-db/src/db.ts` and implementation in `packages/runner-db/src/workspaces.ts`**
  Table:
  ```sql
  CREATE TABLE IF NOT EXISTS custom_workspaces (
    workspace_id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    added_at INTEGER NOT NULL
  );
  ```
  Implement `addCustomWorkspace` and `listCustomWorkspaces`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `bun test packages/runner-db/src/workspaces.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add packages/runner-db/
  git commit -m "feat(runner-db): persist custom user workspaces across boots"
  ```

---

### Task 3: Automatic Workspace Discovery on Runner

**Files:**
- Modify: `apps/runner/src/workspaces/workspaces.ts`
- Test: `apps/runner/src/workspaces/workspaces.test.ts`

**Interfaces:**
- Consumes: `listCustomWorkspaces` from `@cc-web/runner-db`
- Produces: `discoverWorkspaces(options: { defaultEnv?: string; db?: Database; homeDir?: string }): DeclaredWorkspace[]`, `workspaceResolverFrom(workspaces: DeclaredWorkspace[]): (workspaceId: string) => string | undefined`

- [ ] **Step 1: Write failing tests in `apps/runner/src/workspaces/workspaces.test.ts`**
  Test combining `CC_WEB_RUNNER_DEFAULT_WORKSPACE`, scanned `~/.claude/projects`, and `custom_workspaces`. Verify slug generation and deterministic `workspaceId`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `bun test apps/runner/src/workspaces/workspaces.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement `discoverWorkspaces` in `apps/runner/src/workspaces/workspaces.ts`**
  - Read `~/.claude/projects/` directory if present.
  - Parse session files or decode paths, filter existing directories.
  - Merge with `defaultEnv` and `listCustomWorkspaces(db)`.
  - Assign deterministic `workspaceId` (slug + hash if needed).
  - Return `DeclaredWorkspace[]`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `bun test apps/runner/src/workspaces/workspaces.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add apps/runner/src/workspaces/
  git commit -m "feat(runner): discover claude code workspaces and custom directories"
  ```

---

### Task 4: Directory Browser Handler on Runner

**Files:**
- Create: `apps/runner/src/browse/handler.ts`
- Test: `apps/runner/src/browse/handler.test.ts`

**Interfaces:**
- Produces: `createBrowseHandler(options?: { homeDir?: string }): (command: unknown) => Promise<RpcResultFrame>`

- [ ] **Step 1: Write failing tests in `apps/runner/src/browse/handler.test.ts`**
  Test browsing `~`, browsing absolute path, shortcuts (`~`, `/`, `/mnt`), parent path navigation, directory detection (`isDir`, `isGitRepo`), and error handling for inaccessible paths.

- [ ] **Step 2: Run test to verify it fails**
  Run: `bun test apps/runner/src/browse/handler.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement `createBrowseHandler` in `apps/runner/src/browse/handler.ts`**
  - Handle `workspace.fs.browse`.
  - Normalize path with `path.resolve`.
  - Use `fs.readdir` with `{ withFileTypes: true }`.
  - Check for `.git` and `.claude`.
  - Bounded results (up to 500 entries, dirs first, then files).

- [ ] **Step 4: Run test to verify it passes**
  Run: `bun test apps/runner/src/browse/handler.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add apps/runner/src/browse/
  git commit -m "feat(runner): implement directory browser rpc handler"
  ```

---

### Task 5: Claude Sessions Inspection Handler on Runner

**Files:**
- Create: `apps/runner/src/sessions/handler.ts`
- Test: `apps/runner/src/sessions/handler.test.ts`

**Interfaces:**
- Produces: `createSessionsHandler(options: { workspacePathFor: (id: string) => string | undefined; sdk?: { listSessions: Function; getSessionMessages: Function } }): (command: unknown) => Promise<RpcResultFrame>`

- [ ] **Step 1: Write failing tests in `apps/runner/src/sessions/handler.test.ts`**
  Test `workspace.sessions.list` and `workspace.sessions.messages` using injected mock SDK functions.

- [ ] **Step 2: Run test to verify it fails**
  Run: `bun test apps/runner/src/sessions/handler.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement `createSessionsHandler` in `apps/runner/src/sessions/handler.ts`**
  - Handle `workspace.sessions.list`: resolve directory, call `sdk.listSessions({ dir, limit, offset, includeProgrammatic: false })`.
  - Handle `workspace.sessions.messages`: call `sdk.getSessionMessages(sessionId, { dir, limit, offset, includeSystemMessages: false })`.
  - Return formatted results or clean refusals on error.

- [ ] **Step 4: Run test to verify it passes**
  Run: `bun test apps/runner/src/sessions/handler.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add apps/runner/src/sessions/
  git commit -m "feat(runner): implement claude code sessions inspect handler"
  ```

---

### Task 6: Runner Daemon Wiring & Capabilities

**Files:**
- Modify: `apps/runner/src/daemon.ts`
- Modify: `apps/runner/src/bootstrap/main.ts`
- Test: `apps/runner/src/daemon.test.ts`

**Interfaces:**
- Consumes: `createBrowseHandler`, `createSessionsHandler`, `discoverWorkspaces`
- Produces: Runner advertises `workspace.browse` and `workspace.sessions` in hello frame capabilities, dispatches incoming browse & sessions RPC commands.

- [ ] **Step 1: Write failing tests in `apps/runner/src/daemon.test.ts`**
  Verify hello frame carries new capabilities and dispatch routes `workspace.fs.browse`, `workspace.sessions.list` to new handlers.

- [ ] **Step 2: Run test to verify it fails**
  Run: `bun test apps/runner/src/daemon.test.ts`
  Expected: FAIL

- [ ] **Step 3: Update `daemon.ts` and `main.ts`**
  - Add capabilities to `RUNNER_CAPABILITIES`.
  - Compose `browse` and `sessions` handlers in `startDaemon`.
  - Route in `dispatch()` pre-switch.
  - In `main.ts`, use `discoverWorkspaces` so all discovered projects are announced with `branches: listBranches(w.path)`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `bun test apps/runner/src/daemon.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add apps/runner/
  git commit -m "feat(runner): wire browse and sessions handlers into daemon"
  ```

---

### Task 7: Runner Execution Resume Session Support

**Files:**
- Modify: `apps/runner/src/execution/executor.ts`
- Test: `apps/runner/src/execution/executor.test.ts`

**Interfaces:**
- Consumes: `payload["resumeSessionId"]` from `run.start` command payload
- Produces: Sets `resume` in `SdkStreamInput` to `payload["resumeSessionId"] ?? sdkSessionIdForSession(db, sessionId)`

- [ ] **Step 1: Write failing tests in `apps/runner/src/execution/executor.test.ts`**
  Test that when `resumeSessionId` is present in `run.start` payload, it is passed directly to `options.sdk({ resume: resumeSessionId })`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `bun test apps/runner/src/execution/executor.test.ts`
  Expected: FAIL

- [ ] **Step 3: Update `apps/runner/src/execution/executor.ts`**
  Check `payload["resumeSessionId"]` alongside `sdkSessionIdForSession`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `bun test apps/runner/src/execution/executor.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add apps/runner/src/execution/
  git commit -m "feat(runner): allow resuming specific claude code session via payload"
  ```

---

### Task 8: Control Server REST Endpoints for Browse & Sessions

**Files:**
- Create: `apps/control-server/src/routes/browse-routes.ts`
- Create: `apps/control-server/src/routes/sessions-routes.ts`
- Modify: `apps/control-server/src/server.ts`
- Test: `apps/control-server/src/routes/browse-routes.test.ts`
- Test: `apps/control-server/src/routes/sessions-routes.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/runners/:runnerId/browse?path=...`
  - `GET /api/workspaces/:workspaceId/sessions`
  - `GET /api/workspaces/:workspaceId/sessions/:sessionId/messages`
  - `POST /api/runners/:runnerId/workspaces` (register custom path)

- [ ] **Step 1: Write failing route tests**
  Test authentication, validation, RPC submission via `submitRpc`, and response formatting.

- [ ] **Step 2: Run test to verify it fails**
  Run: `bun test apps/control-server/src/routes/browse-routes.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement routes and wire into `apps/control-server/src/server.ts`**
  Use `submitRpc` with `BROWSE_CAPABILITY` and `SESSIONS_CAPABILITY`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `bun test apps/control-server/src/routes/browse-routes.test.ts apps/control-server/src/routes/sessions-routes.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add apps/control-server/
  git commit -m "feat(server): expose browse and session history endpoints"
  ```

---

### Task 9: Control Server Runs Route Resume Support

**Files:**
- Modify: `apps/control-server/src/routes/runs-routes.ts`
- Modify: `packages/control-db/src/scheduler.ts`
- Test: `apps/control-server/src/routes/runs-routes.test.ts`
- Test: `packages/control-db/src/scheduler.test.ts`

**Interfaces:**
- Produces: `POST /api/runs` accepts optional `resumeSessionId?: string`, forwards in `run.start` payload.

- [ ] **Step 1: Write failing tests in `runs-routes.test.ts` and `scheduler.test.ts`**
  Test that `resumeSessionId` in request body is validated (non-empty string or UUID) and enqueued in `run.start` payload.

- [ ] **Step 2: Run test to verify it fails**
  Run: `bun test apps/control-server/src/routes/runs-routes.test.ts`
  Expected: FAIL

- [ ] **Step 3: Update `runs-routes.ts` and `scheduler.ts`**
  Accept `resumeSessionId` in `DispatchRequest` and include in outbox `payload`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `bun test apps/control-server/src/routes/runs-routes.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add apps/control-server/ packages/control-db/
  git commit -m "feat(server): forward resumeSessionId through scheduler dispatch"
  ```

---

### Task 10: Web Services for Browse & Sessions

**Files:**
- Create: `apps/web/src/services/browse-api.ts`
- Create: `apps/web/src/services/sessions-api.ts`
- Modify: `apps/web/src/services/runs-api.ts`
- Test: `apps/web/src/services/browse-api.test.ts`

**Interfaces:**
- Produces: `fetchDirectory(runnerId: string, path?: string)`, `fetchWorkspaceSessions(workspaceId: string, runnerId?: string)`, `fetchSessionMessages(workspaceId: string, sessionId: string, runnerId?: string)`, `registerWorkspace(runnerId: string, path: string)`

- [ ] **Step 1: Write failing service tests**
  Mock `fetch` and verify request parameters and return shapes.

- [ ] **Step 2: Run test to verify it fails**
  Run: `bun test apps/web/src/services/browse-api.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement web API services**
  Add fetch wrappers with typed return contracts.

- [ ] **Step 4: Run test to verify it passes**
  Run: `bun test apps/web/src/services/browse-api.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add apps/web/src/services/
  git commit -m "feat(web): add client api services for browse and session history"
  ```

---

### Task 11: Web Directory Browser Modal Component

**Files:**
- Create: `apps/web/src/components/FolderBrowserModal.vue`
- Test: `apps/web/src/components/FolderBrowserModal.test.ts`

**Interfaces:**
- Props: `open: boolean`, `runnerId: string`
- Emits: `close`, `select(path: string)`

- [ ] **Step 1: Write component unit test**
  Mount component with mock API, test navigation, breadcrumbs, shortcut clicks (`~`, `/`, `/mnt`), folder selection.

- [ ] **Step 2: Run test to verify it fails**
  Run: `bun test apps/web/src/components/FolderBrowserModal.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement `FolderBrowserModal.vue`**
  - Render breadcrumb navigation and shortcuts.
  - List folders with folder icons.
  - "Select this folder" confirmation button.
  - Follow shadcn theme guidelines (no custom palette).

- [ ] **Step 4: Run test to verify it passes**
  Run: `bun test apps/web/src/components/FolderBrowserModal.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add apps/web/src/components/
  git commit -m "feat(web): create folder browser modal component"
  ```

---

### Task 12: Composer Workspace & Session Picker

**Files:**
- Modify: `apps/web/src/components/Composer.vue`
- Test: `apps/web/src/components/Composer.test.ts`

**Interfaces:**
- User can:
  1. Pick a workspace from auto-discovered list or click "Browse folder...".
  2. Once workspace is chosen, view list of existing Claude Code sessions.
  3. Choose "New Session" or click an existing session to resume.

- [ ] **Step 1: Write failing tests in `apps/web/src/components/Composer.test.ts`**
  Test workspace selection, session selection, and verify `startRun` receives `resumeSessionId`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `bun test apps/web/src/components/Composer.test.ts`
  Expected: FAIL

- [ ] **Step 3: Update `Composer.vue`**
  Integrate `FolderBrowserModal`, add session selector dropdown/list for the active workspace, bind selected session to submit payload.

- [ ] **Step 4: Run test to verify it passes**
  Run: `bun test apps/web/src/components/Composer.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add apps/web/src/components/Composer.vue
  git commit -m "feat(web): add workspace folder browser and session picker to composer"
  ```

---

### Task 13: Historical Conversation Message Replay in Web UI

**Files:**
- Modify: `apps/web/src/components/EventJournal.vue`
- Test: `apps/web/src/components/EventJournal.test.ts`

**Interfaces:**
- Props / Store: Accepts preloaded historical messages when resuming a session and renders them in chronological order above live events.

- [ ] **Step 1: Write failing tests in `EventJournal.test.ts`**
  Verify historical messages render with distinct timestamp / visual indicator and live events append seamlessly after them.

- [ ] **Step 2: Run test to verify it fails**
  Run: `bun test apps/web/src/components/EventJournal.test.ts`
  Expected: FAIL

- [ ] **Step 3: Update `EventJournal.vue`**
  Render historical conversation entries prior to the first live run event.

- [ ] **Step 4: Run test to verify it passes**
  Run: `bun test apps/web/src/components/EventJournal.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add apps/web/src/components/EventJournal.vue
  git commit -m "feat(web): render historical conversation messages when resuming session"
  ```

---

### Task 14: Full Suite Quality Gates & Build Verification

**Files:**
- Verification only

- [ ] **Step 1: Run complete test suite**
  Run: `bun test`
  Expected: All unit tests pass across all packages and apps.

- [ ] **Step 2: Run TypeScript typecheck**
  Run: `bun run typecheck`
  Expected: No errors.

- [ ] **Step 3: Run Biome lint**
  Run: `bun run lint`
  Expected: No lint or format violations.

- [ ] **Step 4: Build web SPA**
  Run: `cd apps/web && bun run build`
  Expected: Build finishes with exit code 0.

- [ ] **Step 5: Commit & Final Wrap-up**
  ```bash
  git status
  ```
