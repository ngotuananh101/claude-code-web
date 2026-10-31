# P3-C: Profiles & Overrides Design Spec

- Date: 2026-10-31
- Status: Draft (Pending User Approval)
- Scope: P3-C slice of `docs/ARCHITECTURE.md` (§8, §17.1, §18.1), replacing earlier placeholder scope (`maxTurns`, `maxBudgetUsd`, `instructionAppend`) with focused Upstream Profiles & Claude Code Settings Overrides.

---

## 1. Intent & Problem Solved

### The Problem
Currently, cc-web runners execute Claude Code CLI sessions using the host runner's static environment and `~/.claude/settings.json`. An operator cannot:
1. Direct individual sessions to an alternate upstream provider or gateway (such as 9Router, One API, or an internal corporate proxy) without altering the global host configuration.
2. Run two concurrent sessions targeting different endpoints or API keys simultaneously.
3. Map Claude Code model roles (`Sonnet`, `Opus`, `Haiku`, `Fable`, `Subagent`) to upstream custom model names (e.g. `prime`, `titan`, `nano`) on a per-session basis.

### The Solution
Introduce **Profiles** — named configurations stored on the Control Server containing upstream connection details, credentials, model mappings, and raw Claude Code settings. 
- Profiles are applied **strictly per session** at turn dispatch time.
- If a session does not select a profile, it defaults to the runner's native host configuration.
- A dedicated **Profiles Management** view (`/profiles`) allows creating, editing, and deleting profiles with both a visual form (with model mapping) and a direct JSON configuration editor (synchronized two-way).
- The Composer's model picker popover allows switching between profiles seamlessly for any session.

---

## 2. Goals, Non-Goals & Anti-Goals

### Goals
- **Multi-provider concurrency**: Two sessions can run concurrently with different endpoints, keys, and model mappings without interference.
- **Dedicated management UI (`/profiles`)**: A dedicated route in the web console with:
  - List of configured profiles.
  - Visual form: Name, API Endpoint, API Key, Auth Field selector (`ANTHROPIC_AUTH_TOKEN` vs `ANTHROPIC_API_KEY`), and Model Mapping table.
  - Direct JSON Editor: Full Claude Code settings object (`env`, `permissions`, `model`, etc.), live-synced with the form.
- **Integrated Composer Popover**: In `ModelPickerPopover.vue`, a profile selector sits above the model list. Selecting a profile activates its mapped models.
- **Zero runner environment pollution**: Profile credentials and variables are injected solely into the query options (`options.env` and `options.settings`) of the target run's SDK stream, leaving the daemon's host process environment untouched.
- **Fallback to native runner**: Sessions without an explicit profile continue to use the runner host's existing `process.env` and `settingSources: ["user", "project", "local"]`.

### Non-Goals
- Global default enforcement: No runner-wide or workspace-wide mandatory default profile (explicitly removed per user direction: "không cần setting cho runner hay workspace nữa mà trong từng phiên chọn provider nào thì sẽ áp dụng thôi").
- In-flight profile switching: A profile override is snapshotted when a run starts; changing a profile definition does not alter an already running attempt.
- Editing runner host configuration files (`~/.claude/settings.json` on disk) directly via web UI (reserved for a later administrative phase).

### Anti-Goals
- Leaking raw API keys in control event journals: `run_events` and public event streams must never log raw API keys.
- Complex billing/budget clamps (`maxTurns`, `maxBudgetUsd`) are out of scope for this slice.

---

## 3. Architecture & Data Flow

```
+-----------------------------------------------------------------------+
| Control Server                                                        |
|                                                                       |
|   SQLite: `config_profiles` table                                     |
|   CRUD REST: `/api/config/profiles[/:id]`                             |
|                                                                       |
|   POST /api/sessions/:id/runs                                         |
|     -> reads `profileId` from body                                    |
|     -> loads profile, builds resolved RunProfilePayload               |
|     -> dispatches `run.start` via Scheduler                           |
+-----------------------------------------------------------------------+
                                   |
                       WebSocket: `run.start`
                       (payload includes `profile`)
                                   v
+-----------------------------------------------------------------------+
| Runner Daemon                                                         |
|                                                                       |
|   `RunController` & `Executor`                                        |
|     -> parses `profile` from `run.start` payload                      |
|     -> constructs ephemeral `env` overlay:                            |
|          ANTHROPIC_BASE_URL = profile.endpoint                       |
|          ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY = profile.apiKey    |
|          ANTHROPIC_DEFAULT_*_MODEL = modelMapping[*]                  |
|          CLAUDE_CODE_SUBAGENT_MODEL = modelMapping.subagent           |
|          + any extra env in profile.settings.env                      |
|     -> constructs ephemeral `settings` overlay                        |
|                                                                       |
|   `agent-adapter`: `createSdkStream(input)`                           |
|     -> passes `env: { ...process.env, ...input.env }`                 |
|     -> passes `settings: { ...input.settings }`                      |
|     -> calls SDK `query({ prompt, options })`                         |
+-----------------------------------------------------------------------+
```

---

## 4. Detailed Design

### 4.1 Data Model (`packages/control-db`)
New table `config_profiles`:

```sql
CREATE TABLE IF NOT EXISTS config_profiles (
  id TEXT PRIMARY KEY,               -- e.g. 'prof_' + nanoid / uuid
  owner_id TEXT NOT NULL,            -- owner user id
  name TEXT NOT NULL,                -- e.g. '9Router'
  endpoint TEXT NOT NULL,            -- e.g. 'http://192.168.2.3:20128'
  auth_field TEXT NOT NULL,          -- 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY'
  api_key_encrypted TEXT,            -- encrypted key string (or masked token storage)
  model_mapping TEXT NOT NULL,       -- JSON: { sonnet?: string, opus?: string, haiku?: string, fable?: string, subagent?: string }
  settings_json TEXT NOT NULL,       -- JSON: arbitrary valid Claude Code settings object
  created_at INTEGER NOT NULL,       -- epoch ms
  updated_at INTEGER NOT NULL        -- epoch ms
);

CREATE INDEX IF NOT EXISTS config_profiles_owner
  ON config_profiles (owner_id, updated_at DESC);
```

### 4.2 Control Server REST API (`apps/control-server`)
Under `apps/control-server/src/routes/config-routes.ts`:

- `GET /api/config/profiles`: Returns list of profiles for the authenticated owner. Note: `apiKey` is returned masked (e.g. `sk-...` or empty flag `hasKey: boolean`) to avoid leaking secrets to the browser.
- `GET /api/config/profiles/:id`: Returns a single profile.
- `POST /api/config/profiles`: Creates a profile.
  - Body: `{ name, endpoint, authField, apiKey, modelMapping, settingsJson }`
  - Validates: non-empty name, valid HTTP/HTTPS endpoint URL, valid JSON strings for `modelMapping` and `settingsJson`.
- `PUT /api/config/profiles/:id`: Updates an existing profile.
  - If `apiKey` is omitted or empty string, preserves previously saved key.
- `DELETE /api/config/profiles/:id`: Deletes a profile.

### 4.3 Dispatch & Protocol Contract (`packages/protocol`)
`RunProfilePayload` added to `@cc-web/protocol`:

```ts
export type RunProfilePayload = {
  profileId: string;
  name: string;
  endpoint: string;
  authField: "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";
  apiKey?: string;
  modelMapping?: {
    sonnet?: string;
    opus?: string;
    haiku?: string;
    fable?: string;
    subagent?: string;
  };
  settings?: Record<string, unknown>;
};
```

In `run.start` command payload:
- Optional `profile?: RunProfilePayload`.
- Control Server redacts `apiKey` in command outbox / event persistence where necessary, or logs as `[REDACTED]` in debug traces.

### 4.4 Runner Execution (`apps/runner` & `packages/agent-adapter`)

In `packages/agent-adapter/src/index.ts`:
- Extend `SdkStreamInput`:
  ```ts
  export type SdkStreamInput = {
    ...
    env?: Record<string, string | undefined>;
    settings?: Record<string, unknown>;
  };
  ```
- In `createSdkStream`:
  - When `input.env` is supplied:
    `options["env"] = { ...process.env, ...input.env };`
  - When `input.settings` is supplied:
    `options["settings"] = { ...(options["settings"] as Record<string, unknown> | undefined), ...input.settings };`

In `apps/runner/src/execution/executor.ts`:
- When `payload.profile` is present:
  - Formulate environment dictionary:
    - `ANTHROPIC_BASE_URL`: `profile.endpoint`
    - `[profile.authField]`: `profile.apiKey` (if present)
    - If `profile.modelMapping.sonnet`: `ANTHROPIC_DEFAULT_SONNET_MODEL: profile.modelMapping.sonnet`
    - If `profile.modelMapping.opus`: `ANTHROPIC_DEFAULT_OPUS_MODEL: profile.modelMapping.opus`
    - If `profile.modelMapping.haiku`: `ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.modelMapping.haiku`
    - If `profile.modelMapping.fable`: `ANTHROPIC_DEFAULT_FABLE_MODEL: profile.modelMapping.fable`
    - If `profile.modelMapping.subagent`: `CLAUDE_CODE_SUBAGENT_MODEL: profile.modelMapping.subagent`
    - Merge any extra key-values declared in `profile.settings?.env`.
  - Pass merged `env` and `settings` into `SdkOptions`.

### 4.5 Web Console UI (`apps/web`)

1. **Navigation Link in `SessionRail.vue`**:
   - Add a navigation item for **Profiles** (`/profiles`) below Dashboard and Runners.

2. **Dedicated Profiles Page (`apps/web/src/views/ProfilesView.vue`)**:
   - List existing profiles with Name, Endpoint, Auth Field, and Model Mapping tags.
   - Profile Editor split into two views:
     - **Left (Visual Form)**: Name, Endpoint, API Key, Auth Field select, and interactive Model Mapping table for Sonnet, Opus, Haiku, Fable, Subagent.
     - **Right (JSON Editor)**: Direct textarea / code editor displaying the generated or custom Claude Code config JSON (`env`, `permissions`, `model`, etc.).
     - Edits in Visual Form instantly update the JSON Editor, and valid edits in the JSON Editor update form fields.

3. **Composer Popover Integration (`ModelPickerPopover.vue`)**:
   - Add Profile dropdown at the top of the popover:
     - "Mặc định (Runner Host)"
     - List of saved profiles.
   - When a profile with model mapping is selected:
     - The model options display the mapped names (e.g. `Sonnet (prime)`).
   - Composer toolbar chip displays: `[Profile Name] / [Model] ([Effort])`.
   - On run submission (`POST /api/sessions/:id/runs`), `profileId` is included in the request body.

---

## 5. Security & Isolation

1. **Subprocess Isolation**: Variables passed via `options.env` to `@anthropic-ai/claude-agent-sdk` only affect the child process running the query. The runner daemon process, other runner jobs, and other workspaces are completely unaffected.
2. **Credential Redaction**:
   - API keys are not echoed in client-facing GET responses (only masked or boolean presence).
   - WebSocket event logs and error messages are scrubbed through runner's existing `redact.ts`.
3. **Validation**: Endpoints must be valid URLs (http or https). Settings JSON must be well-formed JSON and must not contain executable code or script injection.

---

## 6. Verification Plan

1. **Unit Tests**:
   - `packages/control-db`: CRUD queries for `config_profiles`.
   - `apps/control-server`: Routes test for `GET/POST/PUT/DELETE /api/config/profiles`, validation, auth requirements.
   - `packages/agent-adapter`: Verify `createSdkStream` properly injects `options.env` and `options.settings`.
   - `apps/runner`: Executor test verifying that a `run.start` carrying `profile` populates SDK options with `ANTHROPIC_BASE_URL`, auth token, and model environment variables.
   - `apps/web`: Pure logic unit tests for profile serialization, model mapping resolution, and JSON synchronization.
2. **Integration Verification**:
   - Start test runner and control server.
   - Create a profile with dummy endpoint `http://192.168.2.3:20128` and model mapping `sonnet -> prime`.
   - Dispatch a run selecting that profile.
   - Verify runner receives the command, populates SDK options with the overlay env, and starts the child process with the custom endpoint and token.
3. **Full Gates**:
   - `bun test`
   - `bun run typecheck`
   - `bun run lint`
   - `cd apps/web && bun run build`

---

## 7. Builder Check Clarifications & Decisions

Following the builder review pass, these specific implementation choices are locked in:

1. **SDK `options.env` and `options.settings` Interface**:
   `@anthropic-ai/claude-agent-sdk` natively supports `options.env` and `options.settings`. Because the SDK replaces the subprocess environment when `options.env` is supplied, `packages/agent-adapter` must always spread the runner host's `process.env` first:
   ```ts
   if (input.env !== undefined) {
     options["env"] = { ...process.env, ...input.env };
   }
   if (input.settings !== undefined) {
     options["settings"] = {
       ...(options["settings"] as Record<string, unknown> | undefined),
       ...input.settings,
     };
   }
   ```

2. **Secret Flow & Storage**:
   Per operator guidance, Control Server is the key holder. Profiles in `config_profiles` store the key masked/encrypted. At dispatch time, the server builds the ephemeral `RunProfilePayload` with the key and sends it over the authenticated WebSocket link to the runner. `command_outbox` persistence masks `apiKey` when persisting to disk so plaintext keys are not retained in outbox histories, while the live WebSocket frame delivers the credential to the runner memory.

3. **Auth Field Mapping**:
   Claude Code CLI evaluates both `ANTHROPIC_AUTH_TOKEN` (standard for gateways/proxies like 9Router) and `ANTHROPIC_API_KEY` (standard for official Anthropic endpoints). The executor sets `env[profile.authField] = profile.apiKey`.

4. **Two-Way Form/JSON Sync**:
   The visual form edits the primary properties (`name`, `endpoint`, `apiKey`, `authField`, `modelMapping`). Changes to these fields regenerate the corresponding `env` and top-level fields in the JSON editor. Conversely, edits in the JSON editor are parsed: if valid JSON, known fields update the visual form; if invalid JSON, a syntax error badge is shown and saving is disabled until fixed.

5. **Model Role Closed Set**:
   The `modelMapping` object supports a closed set of 5 roles: `sonnet`, `opus`, `haiku`, `fable`, `subagent`.
   - `sonnet` -> `ANTHROPIC_DEFAULT_SONNET_MODEL`
   - `opus` -> `ANTHROPIC_DEFAULT_OPUS_MODEL`
   - `haiku` -> `ANTHROPIC_DEFAULT_HAIKU_MODEL`
   - `fable` -> `ANTHROPIC_DEFAULT_FABLE_MODEL`
   - `subagent` -> `CLAUDE_CODE_SUBAGENT_MODEL`
   The REST validation rejects unexpected keys in `modelMapping`.

