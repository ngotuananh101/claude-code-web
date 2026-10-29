# Workspace Discovery, Folder Browser & Session Resume — Design

> Brainstorm output for runner workspace discovery, directory browser RPC,
> Claude Code session listing, resume-by-id, and historical message replay.
> All rulings below are the implementer's calls based on user requirements
> ("Chọn folder có trên runner - Bạn tìm các session có sẵn của claude code
> dựa trên folder đó - Người dùng sẽ chọn session sẵn có đó hoặc chọn tạo
> session mới", root từ `~/` và `/mnt`, "Có cần đọc lại được tin nhắn cũ").

## 1. Intent and Why

Today, the runner only serves a single static workspace configured via
`CC_WEB_RUNNER_DEFAULT_WORKSPACE`. If this variable is unset or points to an
unrelated path, the runner connects in a `ready` state but refuses runs with
`unknown_workspace`, while the web UI provides no mechanism to discover
existing projects, browse directories on the host, or attach to existing
conversations.

This feature enables:
1. **Automatic discovery** of known workspaces and Claude Code projects on the runner host.
2. **Directory browser RPC** allowing users to pick any folder on the runner host (starting from `~/`, `/mnt`, `/`, etc.).
3. **Session discovery** for a chosen workspace path using the Claude Agent SDK (`listSessions({ dir })`).
4. **Session resume & history playback** so users can either continue an existing Claude Code session (restoring past messages) or start a new session in that folder.

## 2. User Journey & Core Flow

1. **Open New Session Modal / Selector in Web UI**:
   - User selects an online runner.
   - User sees a list of **known workspaces** (from initial runner sync + recent workspaces).
   - Beside or below the list, there is a **"Browse folders..."** button.
2. **Browse Folders**:
   - A modal opens browsing the runner's filesystem via RPC (`workspace.fs.browse`).
   - Quick shortcuts: Home (`~`), Root (`/`), Mounts (`/mnt`), and known drive paths.
   - User navigates directories and clicks "Select this folder".
3. **Session Discovery for Folder**:
   - Once a folder is selected, the UI triggers `workspace.sessions.list` for that directory.
   - The UI displays:
     - **"New conversation"** (creates a fresh session in this folder).
     - **List of existing Claude Code sessions** found in this folder (title/summary, last modified date, git branch).
4. **Selecting a Session**:
   - If user chooses an existing session:
     - UI fetches past messages via `workspace.sessions.messages`.
     - The event journal/conversation view renders the past user & assistant messages.
     - New runs sent from Composer pass `resumeSessionId: "<sdkSessionId>"`, instructing the runner to resume that conversation via SDK options (`options["resume"]`).
   - If user chooses "New conversation":
     - Starts a fresh session in that folder (`resume` is omitted).

## 3. Architecture & Protocol Changes

### 3.1. Capability & RPC Commands

We introduce capability `workspace.browse` and `workspace.sessions` (or consolidated under `workspace.inspect` / extended `workspace.inspect`).

Runner advertises capabilities on hello:
- `workspace.inspect` (already exists for file/git inspect)
- `workspace.browse` (directory listing & path navigation)
- `workspace.sessions` (Claude Code SDK session list & transcript reading)

#### RPC 1: `workspace.fs.browse`
- **Command Kind**: `workspace.fs.browse`
- **Request Payload**:
  ```ts
  export type FsBrowseRequest = {
    path?: string; // empty/absent defaults to user homedir (~)
    showHidden?: boolean; // default false
  };
  ```
- **Response Result**:
  ```ts
  export type FsBrowseEntry = {
    name: string;
    path: string;
    isDir: boolean;
    isGitRepo: boolean;
    hasClaudeProject: boolean;
  };

  export type FsBrowseResult = {
    op: "fs.browse";
    currentPath: string;
    parentPath: string | null;
    shortcuts: Array<{ label: string; path: string }>;
    entries: FsBrowseEntry[];
  };
  ```
- **Security & Safety**:
  - Read-only directory listing via `fs.readdir` + `fs.stat`.
  - Rejects broken symlink loops. Bounded entries (max 500 entries per folder, sorted directories first).
  - Standard path normalization via `path.resolve`.

#### RPC 2: `workspace.sessions.list`
- **Command Kind**: `workspace.sessions.list`
- **Request Payload**:
  ```ts
  export type SessionsListRequest = {
    dir: string;
    limit?: number; // default 50, max 200
    offset?: number;
  };
  ```
- **Response Result**:
  ```ts
  export type SessionsListResult = {
    op: "sessions.list";
    dir: string;
    sessions: Array<{
      sessionId: string;
      summary: string;
      gitBranch?: string;
      cwd?: string;
      lastModified: number;
      createdAt?: number;
    }>;
  };
  ```
- **Execution on Runner**:
  - Calls `sdk.listSessions({ dir, limit, offset, includeProgrammatic: false })`.
  - If SDK call throws or directory is not a known project, returns `sessions: []` cleanly without error.

#### RPC 3: `workspace.sessions.messages`
- **Command Kind**: `workspace.sessions.messages`
- **Request Payload**:
  ```ts
  export type SessionMessagesRequest = {
    sessionId: string;
    dir?: string;
    limit?: number; // default 100, max 500
    offset?: number;
  };
  ```
- **Response Result**:
  ```ts
  export type SessionMessagesResult = {
    op: "sessions.messages";
    sessionId: string;
    messages: Array<{
      type: "user" | "assistant" | "system";
      uuid: string;
      message: unknown;
    }>;
  };
  ```
- **Execution on Runner**:
  - Calls `sdk.getSessionMessages(sessionId, { dir, limit, offset, includeSystemMessages: false })`.

### 3.2. Dynamic Workspace Registration & Synchronization

Currently, `DeclaredWorkspace` is `{ workspaceId, path, branches? }`.
When a runner connects:
1. Runner scans `~/.claude/projects` or calls `sdk.listSessions({ limit: 100 })` to collect unique `cwd` paths.
2. Combines with `CC_WEB_RUNNER_DEFAULT_WORKSPACE` (if set).
3. Validates that paths exist on host disk.
4. Generates deterministic `workspaceId` (e.g. slug/hash or relative identifier) so they can be referenced in `workspaces` table.
5. In addition, when user browses and picks a new folder via `workspace.fs.browse`, that folder can be added dynamically as a registered workspace for that runner via a control plane API (`POST /api/workspaces/register`).

### 3.3. Session Resume in Dispatch & Execution

In `POST /api/runs`:
- Accepts optional `resumeSessionId?: string`.
- When present, passes `resumeSessionId` in `run.start` payload.
- Runner's `executeRun` passes `resume: payload.resumeSessionId` to `sdkStreamInput`.
- Claude Agent SDK attaches to the existing session transcript and continues the conversation.

### 3.4. History Playback in Web UI

- When resuming a session, Web UI loads historical messages via `GET /api/workspaces/:workspaceId/sessions/:sessionId/messages`.
- Messages are rendered in `EventJournal` or a dedicated conversation view before live events start streaming.

## 4. Anti-goals & Invariants

- **No arbitrary command execution**: The folder browser is strictly `fs.readdir` + `fs.stat`. No shell commands are executed to browse files.
- **Never expose credentials or sensitive dotfiles**: Files like `.env`, identity files, SSH keys are not readable via this browse API (only directory navigation is supported).
- **No data loss on resume**: Resuming never deletes or resets conversation files; SDK handles appending to the session JSONL.
- **Strictly read-only for session history**: Getting session messages does not mutate or lock the session.
