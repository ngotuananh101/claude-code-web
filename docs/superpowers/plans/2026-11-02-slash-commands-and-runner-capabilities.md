# Slash Commands, Runner Capabilities & Multi-Agent Visualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver complete support for Claude Code commands and agent capabilities in cc-web: Slash command & skills autocomplete in the web composer, discovery and inspection of runner plugins, skills, and MCP servers/tools, and hierarchical visualization of subagent & multi-agent workflow execution on the session timeline.

**Architecture:**
1. **Protocol & Runner Discovery**: The runner probes Claude Code at boot via `query.initializationResult()` and local configuration (`~/.claude/settings.json`, `~/.claude/plugins/installed_plugins.json`) to discover available slash commands, plugin skills, custom agents, and MCP servers. The runner advertises these capabilities in its `hello` handshake frame to the Control Server, which stores and exposes them via `/api/runners` and `/api/runners/:id/capabilities`.
2. **Composer Slash Command Autocomplete**: `Composer.vue` detects `/` at the beginning of a line or prompt, presenting a floating `SlashCommandMenu.vue` with fuzzy filtering, argument hints, classification badges (`Skill`, `Built-in`, `Plugin`), and keyboard navigation (`ArrowUp`, `ArrowDown`, `Enter`, `Tab`, `Escape`).
3. **Runner Capabilities & MCP Inspection UI**: `RunnersView.vue` provides a "Capabilities" dialog with two dedicated tabs: "Plugins & Skills" (listing installed plugins, versions, origins, and associated skills) and "MCP Servers & Tools" (listing configured MCP servers, connection status, and exposed tools).
4. **Hierarchical Subagent & Workflow Visualization**: A pure tree reducer (`subagent-tree.ts`) maps flat background task lifecycle events (`task.started`, `task.progress`, `task.updated`, `task.completed`, `tasks.changed`) into parent-child execution hierarchies. `SubagentProgressTree.vue` renders subagent fan-outs, workflow phases, running tool indicators, and tokens/duration in `BackgroundTaskBand.vue` and `AgentToolStep.vue`, with a clickable `SubagentDetailDialog.vue` for inspecting subagent outputs.

**Tech Stack:** Bun, TypeScript 7, Hono control server, Vue 3 SFC, Tailwind CSS, shadcn-vue tokens, Lucide icons, `@anthropic-ai/claude-agent-sdk`.

**Spec:** `docs/superpowers/specs/2026-11-02-slash-commands-and-runner-capabilities-design.md`

## Global Constraints

- **TDD is mandatory**: Every task must write failing tests first, verify RED, implement minimal code, verify GREEN, and commit.
- **Never edit generated shadcn-vue files**: `apps/web/src/components/ui/**`, `apps/web/src/lib/utils.ts`, `apps/web/src/styles/index.css`, `apps/web/components.json`.
- **Styling**: Use generated CSS variables (`var(--primary)`, `var(--muted-foreground)`, `var(--border)`, etc.) or Tailwind utility classes only.
- **Hygiene**: Never journal or leak raw credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, tokens in MCP environment blocks).
- **Localization**: All user-visible strings must have translation keys in both `apps/web/src/lib/i18n/locales/vi.ts` and `en.ts`.
- **Quality Gates**: Every task must verify `bun test`, `bun run typecheck`, and `bun run lint`.
- **Environment**: `bun` lives in `~/.ponta/bin`: ensure `export PATH="$HOME/.ponta/bin:$PATH"` is present when running commands.

## Review Focus

1. **Autocomplete Selection Cursor Behavior**: Selecting a slash command from the menu must replace only the active `/query` token and place the cursor directly after the command with a trailing space.
2. **Offline Runner Fallback**: When no runner is selected or the runner is offline, the composer must gracefully fall back to default Claude Code built-in commands and common skills rather than failing.
3. **Sanitized MCP Secrets**: Discovery of MCP server configurations must never expose environment variables containing passwords, bearer tokens, or API keys to the browser.
4. **Tree Reconstruction Without Parent Leaks**: If a child subagent arrives before its parent or references a missing `parentTaskId`, it must gracefully attach to the root level without breaking tree rendering.
5. **No Memory Leaks in Timer Intervals**: Task elapsed timers in `SubagentProgressTree.vue` must properly clean up their `setInterval` on unmount.

---

### Task 1: Protocol — Runner Capabilities Data Structures and Parsers

**Files:**
- Create: `packages/protocol/src/capabilities.ts`
- Create: `packages/protocol/src/capabilities.test.ts`
- Modify: `packages/protocol/src/handshake.ts`
- Modify: `packages/protocol/src/handshake.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Consumes: `parseRunnerModels` from `packages/protocol/src/models.ts`
- Produces:
  ```typescript
  export type RunnerCommand = {
    name: string;
    description?: string;
    argumentHint?: string;
    builtin?: boolean;
    aliases?: string[];
  };

  export type RunnerPlugin = {
    name: string;
    version?: string;
    source?: string;
    installPath?: string;
    scope?: string;
  };

  export type RunnerMcpServer = {
    name: string;
    status: "connected" | "failed" | "configured";
    source?: "user" | "project" | "local";
    command?: string;
    tools?: string[];
  };

  export type RunnerAgent = {
    name: string;
    description?: string;
    model?: string;
  };

  export type RunnerCapabilities = {
    commands: RunnerCommand[];
    plugins: RunnerPlugin[];
    mcpServers: RunnerMcpServer[];
    agents: RunnerAgent[];
  };

  export function parseRunnerCommands(input: unknown): RunnerCommand[] | undefined;
  export function parseRunnerPlugins(input: unknown): RunnerPlugin[] | undefined;
  export function parseRunnerMcpServers(input: unknown): RunnerMcpServer[] | undefined;
  export function parseRunnerAgents(input: unknown): RunnerAgent[] | undefined;
  ```

- [ ] **Step 1: Write the failing tests in `capabilities.test.ts` and `handshake.test.ts`**

Cover parsing valid commands, plugins, mcp servers, agents, ignoring malformed records, and negotiating hello frames carrying capabilities.

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/protocol/src/capabilities.test.ts`
Expected: FAIL with module not found or missing export.

- [ ] **Step 3: Implement `capabilities.ts`, update `handshake.ts` and `index.ts`**

Implement defensive array parsers that sanitize records, strip sensitive env blocks, and include capabilities in `NegotiateResult`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/protocol`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/capabilities.ts packages/protocol/src/capabilities.test.ts packages/protocol/src/handshake.ts packages/protocol/src/handshake.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): define runner capabilities and handshake parsers"
```

---

### Task 2: Runner — Capabilities Discovery and Hello Frame Advertising

**Files:**
- Create: `apps/runner/src/execution/capability-catalog.ts`
- Create: `apps/runner/src/execution/capability-catalog.test.ts`
- Modify: `apps/runner/src/daemon.ts`
- Modify: `apps/runner/src/daemon.test.ts`
- Modify: `apps/runner/src/bootstrap/main.ts`

**Interfaces:**
- Consumes: `RunnerCapabilities` from `@cc-web/protocol`, `claudeCliPath` from `@cc-web/agent-adapter`
- Produces: `discoverCapabilities(options: DiscoverCapabilitiesOptions): Promise<RunnerCapabilities>`

- [ ] **Step 1: Write the failing tests in `capability-catalog.test.ts` and `daemon.test.ts`**

Test discovery from SDK `initializationResult()` (commands, agents), parsing `installed_plugins.json`, parsing `settings.json` MCP servers (with secrets stripped), and embedding them into `helloFrame`.

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/runner/src/execution/capability-catalog.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `capability-catalog.ts` and update `daemon.ts` & `bootstrap/main.ts`**

Implement `discoverCapabilities`:
- Start a zero-turn query with `settingSources: ["user", "project", "local"]`.
- Extract `init.commands` and `init.agents`.
- Safely read `~/.claude/plugins/installed_plugins.json` for installed plugins.
- Safely read `~/.claude/settings.json` and project settings for configured `mcpServers` (stripping env secrets).
- Pass discovered capabilities to `startDaemon` and serialize into `helloFrame`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/runner`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/execution/capability-catalog.ts apps/runner/src/execution/capability-catalog.test.ts apps/runner/src/daemon.ts apps/runner/src/daemon.test.ts apps/runner/src/bootstrap/main.ts
git commit -m "feat(runner): discover commands, plugins, agents, and mcp servers at boot"
```

---

### Task 3: Control Server — Gateway Capabilities Store and API Routes

**Files:**
- Modify: `apps/control-server/src/websocket/runner/runner-gateway.ts`
- Modify: `apps/control-server/src/websocket/runner/runner-gateway.test.ts`
- Modify: `apps/control-server/src/routes/runners-routes.ts`
- Modify: `apps/control-server/src/routes/runners-routes.test.ts`

**Interfaces:**
- Consumes: `RunnerCapabilities` from `@cc-web/protocol`
- Produces: `runnerGateway.capabilitiesOf(runnerId: string): RunnerCapabilities | undefined`
- HTTP Endpoint: `GET /api/runners` includes `capabilities` per live runner; `GET /api/runners/:id/capabilities` returns full details.

- [ ] **Step 1: Write the failing tests in `runner-gateway.test.ts` and `runners-routes.test.ts`**

Verify that on handshake hello, the gateway stores capabilities and `/api/runners` exposes them.

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/control-server/src/websocket/runner/runner-gateway.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement capabilities storage in `runner-gateway.ts` and route handler in `runners-routes.ts`**

Store connection capabilities in `Connection` state, expose `capabilitiesOf(runnerId)`, and update `handleListRunners` / `handleGetRunnerCapabilities`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/control-server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-server/src/websocket/runner/runner-gateway.ts apps/control-server/src/websocket/runner/runner-gateway.test.ts apps/control-server/src/routes/runners-routes.ts apps/control-server/src/routes/runners-routes.test.ts
git commit -m "feat(control-server): store and serve runner capabilities via api"
```

---

### Task 4: Web — Slash Commands Registry, Filter Logic, and Autocomplete Component

**Files:**
- Create: `apps/web/src/features/composer/slash-commands.ts`
- Create: `apps/web/src/features/composer/slash-commands.test.ts`
- Create: `apps/web/src/components/SlashCommandMenu.vue`
- Create: `apps/web/src/components/SlashCommandMenu.test.ts`
- Modify: `apps/web/src/services/runners-api.ts`

**Interfaces:**
- Consumes: `RunnerCommand` from `@cc-web/protocol`
- Produces:
  ```typescript
  export type SlashCommandItem = {
    name: string;
    displayName: string;
    description: string;
    argumentHint?: string;
    category: "skill" | "builtin" | "plugin" | "agent";
    pluginName?: string;
  };

  export function getAvailableCommands(runnerCapabilities?: RunnerCapabilities): SlashCommandItem[];
  export function filterCommands(commands: SlashCommandItem[], query: string): SlashCommandItem[];
  export function applyCommandToPrompt(prompt: string, command: SlashCommandItem): { newPrompt: string; cursorPosition: number };
  ```

- [ ] **Step 1: Write the failing tests in `slash-commands.test.ts` and `SlashCommandMenu.test.ts`**

Test command normalization, default builtin/skill fallbacks, fuzzy matching (e.g. `/rev` -> `/code-review`), keyboard selection, and prompt replacement.

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/web/src/features/composer/slash-commands.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `slash-commands.ts` and `SlashCommandMenu.vue`**

Implement fuzzy search, keyboard navigation (`ArrowUp`, `ArrowDown`, `Enter`, `Tab`, `Escape`), badges for `Skill` / `Built-in` / `Plugin`, and proper cursor placement.

- [ ] **Step 4: Run tests to verify they pass**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/web/src/features/composer/slash-commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/composer/slash-commands.ts apps/web/src/features/composer/slash-commands.test.ts apps/web/src/components/SlashCommandMenu.vue apps/web/src/components/SlashCommandMenu.test.ts apps/web/src/services/runners-api.ts
git commit -m "feat(web): add slash commands filter logic and SlashCommandMenu component"
```

---

### Task 5: Web — Integrate Slash Command Autocomplete into Composer

**Files:**
- Modify: `apps/web/src/components/Composer.vue`
- Modify: `apps/web/src/components/Composer.test.ts`
- Modify: `apps/web/src/lib/i18n/locales/vi.ts`
- Modify: `apps/web/src/lib/i18n/locales/en.ts`

**Interfaces:**
- Consumes: `SlashCommandMenu.vue`, `slash-commands.ts`, runner capabilities from `runners-api.ts`
- Produces: Interactive `/` trigger inside the textarea with seamless command insertion.

- [ ] **Step 1: Write the failing test in `Composer.test.ts`**

Test typing `/` opens the autocomplete popover, selecting a command updates the textarea and closes the popover.

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/web/src/components/Composer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Integrate `SlashCommandMenu` into `Composer.vue`**

Attach `input` and `keydown` handlers on `InputGroupTextarea` to trigger the popup when `/` is typed at word boundary, handle keyboard events when menu is open, and apply the selected command.

- [ ] **Step 4: Run tests to verify they pass**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/web/src/components/Composer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/Composer.vue apps/web/src/components/Composer.test.ts apps/web/src/lib/i18n/locales/vi.ts apps/web/src/lib/i18n/locales/en.ts
git commit -m "feat(web): integrate slash command autocomplete into composer textarea"
```

---

### Task 6: Web — Runner Plugins, Skills & MCP Inspection UI

**Files:**
- Create: `apps/web/src/components/RunnerCapabilitiesDialog.vue`
- Create: `apps/web/src/components/RunnerCapabilitiesDialog.test.ts`
- Modify: `apps/web/src/views/RunnersView.vue`
- Modify: `apps/web/src/views/RunnersView.test.ts`
- Modify: `apps/web/src/lib/i18n/locales/vi.ts`
- Modify: `apps/web/src/lib/i18n/locales/en.ts`

**Interfaces:**
- Consumes: `RunnerCapabilities`, `RunnerPlugin`, `RunnerMcpServer` from `@cc-web/protocol`
- Produces: A modal dialog launched from `RunnersView.vue` displaying tabs for "Plugins & Skills" and "MCP Servers & Tools".

- [ ] **Step 1: Write the failing tests in `RunnerCapabilitiesDialog.test.ts` and `RunnersView.test.ts`**

Test rendering plugin items, plugin version, source, related skills, MCP server status pills (`connected`, `failed`, `configured`), and exposed tools.

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/web/src/components/RunnerCapabilitiesDialog.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `RunnerCapabilitiesDialog.vue` and wire into `RunnersView.vue`**

Implement tabbed dialog:
- Tab 1: **Plugins & Skills** (installed plugins with status, version, scope, plus commands/skills list).
- Tab 2: **MCP Servers & Tools** (server name, status badge, command path, tool names).
- Tab 3: **Models & Agents** (supported models and specialized subagent personas).

- [ ] **Step 4: Run tests to verify they pass**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/web/src/components/RunnerCapabilitiesDialog.test.ts apps/web/src/views/RunnersView.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/RunnerCapabilitiesDialog.vue apps/web/src/components/RunnerCapabilitiesDialog.test.ts apps/web/src/views/RunnersView.vue apps/web/src/views/RunnersView.test.ts apps/web/src/lib/i18n/locales/vi.ts apps/web/src/lib/i18n/locales/en.ts
git commit -m "feat(web): add runner capabilities dialog for plugins, skills, and mcp inspection"
```

---

### Task 7: Web — Subagent Hierarchy Tree State & Visualization Components

**Files:**
- Create: `apps/web/src/features/journal/subagent-tree.ts`
- Create: `apps/web/src/features/journal/subagent-tree.test.ts`
- Create: `apps/web/src/components/chat/SubagentProgressTree.vue`
- Create: `apps/web/src/components/chat/SubagentProgressTree.test.ts`
- Create: `apps/web/src/components/chat/SubagentDetailDialog.vue`
- Modify: `apps/web/src/components/chat/BackgroundTaskBand.vue`
- Modify: `apps/web/src/components/chat/AgentToolStep.vue`
- Modify: `apps/web/src/lib/i18n/locales/vi.ts`
- Modify: `apps/web/src/lib/i18n/locales/en.ts`

**Interfaces:**
- Consumes: `BackgroundTask`, `BackgroundTaskState` from `background-tasks.ts`
- Produces:
  ```typescript
  export type SubagentTreeNode = {
    task: BackgroundTask;
    children: SubagentTreeNode[];
    level: number;
  };

  export function buildSubagentTree(tasks: Iterable<BackgroundTask>): SubagentTreeNode[];
  ```

- [ ] **Step 1: Write the failing tests in `subagent-tree.test.ts` and `SubagentProgressTree.test.ts`**

Test tree assembly using `parentTaskId`, handling out-of-order task arrivals, calculating aggregate elapsed time, rendering nested tree nodes, and opening task detail modal.

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/web/src/features/journal/subagent-tree.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `subagent-tree.ts`, `SubagentProgressTree.vue`, and `SubagentDetailDialog.vue`**

Build pure tree reducer, hierarchical UI nodes with collapsible branches, tool execution badges (`task.lastToolName`), token usage counters, and detail viewer modal. Update `BackgroundTaskBand.vue` and `AgentToolStep.vue` to use the tree visualization.

- [ ] **Step 4: Run tests to verify they pass**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/web/src/features/journal/subagent-tree.test.ts apps/web/src/components/chat/SubagentProgressTree.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/journal/subagent-tree.ts apps/web/src/features/journal/subagent-tree.test.ts apps/web/src/components/chat/SubagentProgressTree.vue apps/web/src/components/chat/SubagentProgressTree.test.ts apps/web/src/components/chat/SubagentDetailDialog.vue apps/web/src/components/chat/BackgroundTaskBand.vue apps/web/src/components/chat/AgentToolStep.vue apps/web/src/lib/i18n/locales/vi.ts apps/web/src/lib/i18n/locales/en.ts
git commit -m "feat(web): add hierarchical subagent and workflow progress visualization"
```

---

### Task 8: Verification, Integration Gates & Bilingual Consistency

**Files:**
- Modify: `apps/web/src/lib/i18n/locales/vi.ts`
- Modify: `apps/web/src/lib/i18n/locales/en.ts`
- Test: All unit test suites, typechecks, linter, and web production build.

- [ ] **Step 1: Run full unit test suite**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test`
Expected: All tests pass (0 failures).

- [ ] **Step 2: Run full typecheck gate**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun run typecheck`
Expected: Clean typecheck across all workspaces.

- [ ] **Step 3: Run Biome lint gate**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun run lint`
Expected: Clean linting output (no formatting or rule violations).

- [ ] **Step 4: Run web application production build**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && cd apps/web && bun run build`
Expected: Clean Vite build without warnings or errors.

- [ ] **Step 5: Commit any final polish adjustments**

```bash
git commit -m "chore: ensure all gates and translations pass cleanly"
```
