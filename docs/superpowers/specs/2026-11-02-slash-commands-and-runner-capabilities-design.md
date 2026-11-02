# Claude Code Slash Commands, Runner Capabilities & Multi-Agent Visualization Design

Status: Draft for review, 2026-11-02.

## 1. Intent & Problem Statement

`cc-web` provides a web control plane for Claude coding agents. Currently:
1. **No Slash Command Autocomplete in Web Composer**: When using the Claude Code CLI in a terminal, operators can type `/` to access rich commands and plugin skills (e.g. `/code-review`, `/simplify`, `/debug`, `/loop`, `/superpowers:brainstorming`). In `cc-web`'s web composer, operators must know and type command syntax from memory with zero autocomplete, parameter hints, or discovery.
2. **Hidden Runner Plugins, Skills & Personas**: Runners have various Claude Code plugins installed (e.g. `remember`, `superpowers`, language tools) and specialized agent personas (e.g. `Explore`, `Plan`, `statusline-setup`), but the web control plane only discovers and advertises models (`discoverModels`). Operators cannot see what plugins or skills an attached runner actually has.
3. **No MCP Server & Tool Inspection**: Claude Code instances frequently connect to MCP (Model Context Protocol) servers (e.g. `browseros-neo`, databases, devtools). When an MCP server fails or is unconfigured, operators in `cc-web` have no visibility into which MCP servers and tools are active on that runner.
4. **Limited Subagent & Multi-Agent Progress Visualization**: When agents spawn background subagents (via `Agent` tool) or run multi-agent workflows (via `Workflow` tool / `parallel` / `pipeline`), the web interface only shows a flat notification or a basic collapsed bar (`BackgroundTaskBand.vue`). Operators cannot inspect the hierarchy (`parentTaskId`), view workflow phases, track individual agent tools/token usage, or drill into subagent results.

This design establishes an integrated end-to-end architecture covering:
- **Runner Capability Discovery & Protocol Advertising**: Discovering commands, skills, plugins, MCP servers, and agent personas on runner boot and communicating them to the Control Server.
- **Web Composer Slash Command Autocomplete**: A keyboard-navigable autocomplete popover triggered by `/` in `Composer.vue`.
- **Runner Capabilities & MCP Inspector Dialog**: Dedicated UI in `RunnersView.vue` for inspecting installed plugins, skills, MCP servers, and tools.
- **Hierarchical Subagent & Workflow Visualization**: A tree-based timeline visualization for background tasks, workflow phases, and an interactive subagent inspection modal.

---

## 2. Goals & Non-Goals

### Goals
- **Full Slash Command & Skill Autocomplete**: Triggered on `/` in `Composer.vue`, with fuzzy search, parameter hint display, category badges (`Skill`, `Built-in`, `Plugin`), keyboard navigation (`ArrowUp`/`Down`, `Enter`, `Tab`, `Esc`), and smart cursor placement.
- **Offline / Default Fallback**: If a runner is disconnected or no runner is selected yet, the composer falls back to standard Claude Code commands and core skills.
- **Automatic Runner Discovery**: On runner boot, automatically probe `init.commands`, `init.agents`, installed plugins (`~/.claude/plugins/installed_plugins.json`), and configured MCP servers (`~/.claude/settings.json`), with strict secret sanitization.
- **Safe MCP Inspection**: Display configured MCP servers and their available tools on the web UI, explicitly redacting any credentials or sensitive environment variables.
- **Hierarchical Subagent Visualization**: Reduce `task.*` journal events into a structured tree using `parentTaskId`, displaying running tool states, elapsed time, and token consumption.
- **Workflow Phase & Parallel Task Tracking**: Clearly visualize multi-agent workflows (e.g. `phase('Scan')`, `phase('Fix')`, number of agents running vs completed).
- **Subagent Detail Modal**: Clicking any subagent or workflow task displays full inspection data: subagent type, active/last tool, output summary, token usage, and lifecycle timeline.
- **Bilingual (vi & en)**: Complete translation coverage in `locales/vi.ts` and `locales/en.ts`.

### Non-Goals
- Remote MCP server management/restarts from the web UI: MCP configuration remains owned by the runner host's filesystem and settings; the web UI provides read-only inspection and status diagnostics.
- Direct execution of interactive TUI-only commands (`/color`, `/focus`, `/help` which are blocked by headless SDK mode).
- Real-time video/screencast streaming of browser-based MCP servers: tool call inputs and summaries are displayed as structured data.

---

## 3. Architecture & Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                       RUNNER HOST                                       │
│                                                                                         │
│  ~/.claude/settings.json ──┐                                                            │
│  ~/.claude/plugins/ ───────┼─► capability-catalog.ts ──► helloFrame (capabilities)     │
│  query.initializationResult()                                        │                  │
└──────────────────────────────────────────────────────────────────────┼──────────────────┘
                                                                       │ WS Handshake
                                                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                     CONTROL SERVER                                      │
│                                                                                         │
│  runner-gateway.ts (stores capabilities) ──► GET /api/runners (includes capabilities)   │
└───────────────────────────────────────────────────────┬─────────────────────────────────┘
                                                        │ HTTP REST / WebSocket Events
                                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                         BROWSER                                         │
│                                                                                         │
│  1. Composer.vue ◄──── SlashCommandMenu.vue (autocomplete from runner capabilities)     │
│  2. RunnersView.vue ◄─ RunnerCapabilitiesDialog.vue (Plugins, Skills, MCP Servers)     │
│  3. EventJournal.vue ◄ SubagentProgressTree.vue + SubagentDetailDialog.vue              │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Subsystems Specification

### 4.1 Subsystem 1: Protocol & Runner Capabilities Discovery

#### Protocol Types (`packages/protocol/src/capabilities.ts`)
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
  scope?: "user" | "project" | "local";
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
```

#### Runner Discovery (`apps/runner/src/execution/capability-catalog.ts`)
- **Query Init**: Starts a zero-turn query inheriting host configuration (`settingSources: ["user", "project", "local"]`) to obtain `init.commands` and `init.agents`.
- **Plugin Manifests**: Parses `~/.claude/plugins/installed_plugins.json` and project plugin directories for version and installation metadata.
- **MCP Configuration**: Reads `~/.claude/settings.json` and project settings blocks for configured `mcpServers`.
- **Secret Sanitization**:
  - `FORBIDDEN_ENV_KEYS = ['KEY', 'SECRET', 'TOKEN', 'AUTH', 'PASSWORD', 'CREDENTIAL']`.
  - Strip or blank all environment variables from MCP server definitions before serializing into `helloFrame`.
  - Never transmit credentials over the wire.

#### Handshake & Server Storage
- `apps/runner/src/daemon.ts`: `helloFrame` adds `capabilities: RunnerCapabilities`.
- `apps/control-server/src/websocket/runner/runner-gateway.ts`: Saves capabilities into the live `Connection` object, exposing `capabilitiesOf(runnerId)`.
- `apps/control-server/src/routes/runners-routes.ts`: `GET /api/runners` includes `capabilities` for active runners; `GET /api/runners/:id/capabilities` returns complete runner metadata.

---

### 4.2 Subsystem 2: Slash Command & Skills Autocomplete in Web Composer

#### Trigger & Detection Logic
- In `Composer.vue`, when typing in the prompt textarea:
  - If the prompt starts with `/` or the cursor is preceded by whitespace + `/`, activate the autocomplete menu.
  - Extract the query prefix (e.g. `/co` -> `co`).
  - Close the menu on `Escape` or if the user presses `Backspace` past the `/`.

#### Menu Component (`apps/web/src/components/SlashCommandMenu.vue`)
- **Positioning**: Floats directly above the prompt input with subtle shadow and border, max height ~280px with smooth scrolling.
- **Filtering**:
  - Exact match on command name or alias prefix.
  - Fuzzy matching on command description.
- **Categorization Badges**:
  - `[Skill]`: Plugin skill (e.g. `superpowers:brainstorming`, `code-review`, `dataviz`).
  - `[Built-in]`: Built-in Claude Code command (e.g. `/compact`, `/clear`, `/context`, `/cost`).
  - `[Plugin: <name>]`: Command contributed by an installed plugin.
  - `[Agent: <name>]`: Specialized subagent trigger.
- **Keyboard Navigation**:
  - `ArrowDown` / `ArrowUp`: Move selection index.
  - `Enter` / `Tab`: Insert selected command.
  - `Escape`: Dismiss menu.
- **Insertion**:
  - Replaces `/query` with `/<command-name> `.
  - Places cursor right after the space.
  - If command has an `argumentHint`, displays a subtle preview helper.

#### Fallback State
- When runner is offline or not yet selected:
  - Default catalogue containing core Claude Code commands (`/compact`, `/clear`, `/context`, `/usage`, `/code-review`, `/simplify`, `/debug`, `/verify`, `/loop`) and default superpowers skills.

---

### 4.3 Subsystem 3: Runner Capabilities & MCP Inspection UI

#### Dialog Component (`apps/web/src/components/RunnerCapabilitiesDialog.vue`)
Launched from `RunnersView.vue` via a "Capabilities" / "Chi tiết" button on each runner row.

- **Tab 1: Plugins & Skills (`Plugins & Kỹ năng`)**:
  - Cards listing each installed plugin: Plugin Name, Version, Origin/Source (`superpowers@claude-plugins-official`), Status.
  - Nested list of skills/commands provided by that plugin with one-line descriptions.
- **Tab 2: MCP Servers & Tools (`MCP Servers & Công cụ`)**:
  - Cards for each configured MCP server:
    - Server Name (e.g. `browseros-neo`).
    - Status Badge: `connected` (green), `failed` (red), `configured` (gray).
    - Scope: `user` vs `project`.
    - Sanitized Command / Transport (e.g. `node /path/to/server.js`).
    - Tool count & tool tags (e.g. `mcp__browseros-neo__open`, `mcp__browseros-neo__click`).
- **Tab 3: Models & Personas (`Models & Agents`)**:
  - List of discovered models and specialized agent personas (`Explore`, `Plan`, `general-purpose`).

---

### 4.4 Subsystem 4: Hierarchical Subagent & Workflow Visualization

#### State Representation (`apps/web/src/features/journal/subagent-tree.ts`)
Map flat `BackgroundTask` rows into a hierarchy:
```typescript
export type SubagentTreeNode = {
  task: BackgroundTask;
  children: SubagentTreeNode[];
  depth: number;
  totalDescendants: number;
  aggregateTokens: number;
};

export function buildSubagentTree(tasks: Iterable<BackgroundTask>): SubagentTreeNode[];
```

#### Visual Component (`apps/web/src/components/chat/SubagentProgressTree.vue`)
- Rendered inside `BackgroundTaskBand.vue` (when expanded) and inside `AgentToolStep.vue` (when a tool spawns subagents).
- Tree node elements:
  - Status indicator (pulsing blue dot for `running`, checkmark for `completed`, red alert for `failed`).
  - Subagent / Workflow label (e.g. `Workflow: review-changes`, `Subagent: Explore`, `Subagent: general-purpose`).
  - Workflow phase badge (if `task.workflowName` or phase is present).
  - Current active tool (`task.lastToolName`) in monospace font.
  - Live elapsed time (`formatTaskElapsed`) ticking per second.
  - Token consumption badge (`task.usage.totalTokens`).
  - Clickable node to open detail dialog.

#### Detail Dialog (`apps/web/src/components/chat/SubagentDetailDialog.vue`)
- Displays:
  - Task ID, Parent Task ID, Subagent Type, Workflow Name.
  - Lifecycle: Start time, End time, Duration.
  - Metrics: Input tokens, Output tokens, Tool call count.
  - Output summary / results (`task.summary`).
  - Error diagnostics if failed.

---

## 5. Security & Invariants

1. **Strict Credential Sanitization**:
   - The runner must never send credentials over the WebSocket connection or save them to the control journal.
   - Any MCP server configuration carrying environment variables must have values redacted if keys match credential patterns.
2. **Backward Compatibility**:
   - Older runners that do not send `capabilities` in `hello` must continue to function normally. Control server defaults `capabilities` to empty, and web composer uses default command fallbacks.
3. **No Unbounded DOM Growth**:
   - Subagent trees are capped and virtualized if more than 50 tasks exist; old completed tasks roll up cleanly.
4. **Clean Interval Lifecycle**:
   - All components using ticking intervals (`SubagentProgressTree.vue`, `BackgroundTaskBand.vue`) must clear intervals in `onBeforeUnmount`.

---

## 6. Bilingual Localization (i18n)

All user-visible strings must have keys in `apps/web/src/lib/i18n/locales/vi.ts` and `en.ts`:
- `composer.slashCommands`: Command autocomplete header, filter placeholder, categories.
- `runners.capabilities`: Dialog title, tabs (Plugins, MCP, Models), status badges.
- `subagents.tree`: Subagent tree labels, status, workflow phases, inspect modal fields.

---

## 7. Verification Plan

1. **Unit Tests**:
   - Protocol parsers (`packages/protocol/src/capabilities.test.ts`).
   - Runner discovery (`apps/runner/src/execution/capability-catalog.test.ts`).
   - Control server gateway & API (`apps/control-server/src/websocket/runner/runner-gateway.test.ts`).
   - Web slash commands logic (`apps/web/src/features/composer/slash-commands.test.ts`).
   - Web subagent tree reducer (`apps/web/src/features/journal/subagent-tree.test.ts`).
   - UI component tests (`SlashCommandMenu.test.ts`, `RunnerCapabilitiesDialog.test.ts`, `SubagentProgressTree.test.ts`).
2. **Quality Gates**:
   - `bun test` across monorepo.
   - `bun run typecheck` across monorepo.
   - `bun run lint` (Biome).
   - `cd apps/web && bun run build` (Vite production build).
