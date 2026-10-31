# P3-C: Profiles & Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement upstream provider profiles and settings overrides for cc-web, enabling per-session routing to alternative endpoints (e.g. 9Router, corporate proxies) with custom model mappings and direct Claude Code JSON configuration, managed via a dedicated `/profiles` view and selectable in the Composer.

**Architecture:** 
- `config_profiles` SQLite table in `packages/control-db` stores named profiles (endpoint, authField, masked/encrypted apiKey, model mapping, settings JSON).
- `apps/control-server` provides REST CRUD endpoints `/api/config/profiles[/:id]` and resolves `profileId` into `RunProfilePayload` in `POST /api/sessions/:id/runs`.
- `packages/protocol` defines `RunProfilePayload` and updates `run.start` command payload.
- `apps/runner` and `packages/agent-adapter` merge profile environment variables (`ANTHROPIC_BASE_URL`, auth token, model defaults) and settings into child SDK queries without contaminating host runner state.
- `apps/web` provides the dedicated `/profiles` management view (dual visual form and JSON editor with two-way sync) and integrates profile selection into `ModelPickerPopover.vue`.

**Tech Stack:** Bun, TypeScript, SQLite (`bun:sqlite`), Vue 3, Tailwind CSS.

**Spec:** `docs/superpowers/specs/2026-10-31-p3c-profiles-overrides-design.md`

## Global Constraints

- **Language preference**: All user conversations in Vietnamese; all code, tests, identifiers, and commit messages in English.
- **shadcn-vue invariant**: Never edit or reformat `apps/web/src/components/ui/**`, `apps/web/src/lib/utils.ts`, `apps/web/src/styles/index.css`, or `apps/web/components.json`.
- **Biome overrides**: Generated-file protection override must stay last in `biome.json`.
- **Process isolation**: Subprocess options must spread `process.env` before overlaying `input.env`. Runner process environment must never be permanently mutated.
- **Credentials safety**: API keys must never be logged in cleartext or returned in public GET listings.
- **Closed Model Role Set**: Supported model roles are `sonnet`, `opus`, `haiku`, `fable`, `subagent`.
- **TDD Requirement**: Every task must follow RED -> GREEN -> REFACTOR with tests failing first before implementation.

## Review Focus

1. **Subprocess env leak / pollution**: Runner's `process.env` must remain unchanged after a run completes with custom profile env.
2. **Missing or invalid profile ID in dispatch**: A non-existent `profileId` submitted to `POST /api/sessions/:id/runs` must return 400 Bad Request and not crash the server.
3. **API key masking**: `GET /api/config/profiles` must return `hasKey: boolean` and never return the cleartext `apiKey`.
4. **Invalid JSON in Profile Settings**: Profile creation/update must reject malformed JSON in `settingsJson` with 400 Bad Request.
5. **Two-way sync error boundary in UI**: Invalid JSON entered in the web JSON editor must show an error state and disable saving without crashing the visual form.

---

### Task 1: Protocol Types & Payloads (`packages/protocol`)

**Files:**
- Create: `packages/protocol/src/profiles.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/profiles.test.ts`

**Interfaces:**
- Consumes: Existing protocol types in `packages/protocol/src/index.ts`
- Produces: `RunProfilePayload`, `ModelMapping`, `ProfileAuthField`, `ProfileSummary`, `ProfileDetail`, validation helpers `parseModelMapping`, `parseRunProfilePayload`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/protocol/src/profiles.test.ts
import { describe, expect, test } from "bun:test";
import { parseModelMapping, parseRunProfilePayload, type RunProfilePayload } from "./profiles.ts";

describe("profiles protocol", () => {
  test("validates model mapping with closed set of roles", () => {
    const valid = { sonnet: "prime", opus: "titan", haiku: "nano", fable: "titan", subagent: "prime" };
    expect(parseModelMapping(valid)).toEqual(valid);

    const partial = { sonnet: "prime" };
    expect(parseModelMapping(partial)).toEqual(partial);

    const invalid = { unknownRole: "custom" };
    expect(parseModelMapping(invalid)).toBeUndefined();
  });

  test("validates RunProfilePayload", () => {
    const payload: RunProfilePayload = {
      profileId: "prof_123",
      name: "9Router",
      endpoint: "http://192.168.2.3:20128",
      authField: "ANTHROPIC_AUTH_TOKEN",
      apiKey: "sk-test",
      modelMapping: { sonnet: "prime" },
      settings: { effortLevel: "high" },
    };
    expect(parseRunProfilePayload(payload)).toEqual(payload);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/protocol/src/profiles.test.ts`
Expected: FAIL with module not found or functions undefined

- [ ] **Step 3: Implement `packages/protocol/src/profiles.ts` and export in `packages/protocol/src/index.ts`**

Define `ProfileAuthField = "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY"`, `ModelMapping`, `RunProfilePayload`, `ProfileSummary`, `ProfileDetail`, `parseModelMapping`, and `parseRunProfilePayload`. Export from `packages/protocol/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/protocol/src/profiles.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/profiles.ts packages/protocol/src/profiles.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): add profiles and overrides wire types"
```

---

### Task 2: Database Schema & Repository (`packages/control-db`)

**Files:**
- Create: `packages/control-db/src/profiles.ts`
- Modify: `packages/control-db/src/db.ts`, `packages/control-db/src/index.ts`
- Test: `packages/control-db/src/profiles.test.ts`

**Interfaces:**
- Consumes: `packages/protocol/src/profiles.ts` (`ProfileAuthField`, `ModelMapping`)
- Produces: `createProfile`, `getProfileById`, `getProfileWithSecret`, `listProfilesForOwner`, `updateProfile`, `deleteProfile`, `ProfileRecord`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/control-db/src/profiles.test.ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./db.ts";
import {
  createProfile,
  deleteProfile,
  getProfileById,
  getProfileWithSecret,
  listProfilesForOwner,
  updateProfile,
} from "./profiles.ts";

describe("profiles repository", () => {
  test("CRUD lifecycle for config_profiles", () => {
    const db = new Database(":memory:");
    migrate(db);

    const created = createProfile(db, {
      ownerId: "user-1",
      name: "9Router",
      endpoint: "http://192.168.2.3:20128",
      authField: "ANTHROPIC_AUTH_TOKEN",
      apiKey: "sk-secret-123",
      modelMapping: { sonnet: "prime" },
      settingsJson: JSON.stringify({ effortLevel: "high" }),
    });

    expect(created.id).toBeDefined();
    expect(created.name).toBe("9Router");

    const listed = listProfilesForOwner(db, "user-1");
    expect(listed.length).toBe(1);
    expect(listed[0]!.hasKey).toBe(true);
    expect((listed[0] as Record<string, unknown>).apiKey).toBeUndefined();

    const withSecret = getProfileWithSecret(db, created.id, "user-1");
    expect(withSecret?.apiKey).toBe("sk-secret-123");

    updateProfile(db, created.id, "user-1", {
      name: "9Router Updated",
      modelMapping: { sonnet: "prime-v2" },
    });

    const updated = getProfileById(db, created.id, "user-1");
    expect(updated?.name).toBe("9Router Updated");
    expect(updated?.modelMapping.sonnet).toBe("prime-v2");

    expect(deleteProfile(db, created.id, "user-1")).toBe(true);
    expect(getProfileById(db, created.id, "user-1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/control-db/src/profiles.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement database migration in `db.ts` and repository in `profiles.ts`**

Add table `config_profiles` with columns `id`, `owner_id`, `name`, `endpoint`, `auth_field`, `api_key_encrypted`, `model_mapping`, `settings_json`, `created_at`, `updated_at`, and index `config_profiles_owner` in `packages/control-db/src/db.ts`. Implement functions in `packages/control-db/src/profiles.ts` and re-export in `packages/control-db/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/control-db/src/profiles.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/control-db/src/db.ts packages/control-db/src/profiles.ts packages/control-db/src/profiles.test.ts packages/control-db/src/index.ts
git commit -m "feat(control-db): add config_profiles schema and repository"
```

---

### Task 3: Control Server REST API (`apps/control-server`)

**Files:**
- Create: `apps/control-server/src/routes/config-routes.ts`
- Modify: `apps/control-server/src/server.ts`
- Test: `apps/control-server/src/routes/config-routes.test.ts`

**Interfaces:**
- Consumes: `packages/control-db` (`listProfilesForOwner`, `getProfileById`, `createProfile`, `updateProfile`, `deleteProfile`)
- Produces: `handleListProfiles`, `handleGetProfile`, `handleCreateProfile`, `handleUpdateProfile`, `handleDeleteProfile`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/control-server/src/routes/config-routes.test.ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "@cc-web/control-db";
import { handleCreateProfile, handleListProfiles, handleDeleteProfile, handleUpdateProfile } from "./config-routes.ts";

describe("config-routes (/api/config/profiles)", () => {
  test("creates, lists (with masked secret), updates and deletes profiles", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const authorized = { userId: "user-1", username: "owner" };

    // POST /api/config/profiles
    const createReq = new Request("http://localhost/api/config/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "9Router",
        endpoint: "http://192.168.2.3:20128",
        authField: "ANTHROPIC_AUTH_TOKEN",
        apiKey: "sk-token",
        modelMapping: { sonnet: "prime" },
        settingsJson: "{}",
      }),
    });
    const createRes = await handleCreateProfile(createReq, { db }, authorized);
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; name: string };
    expect(created.id).toBeDefined();

    // GET /api/config/profiles
    const listReq = new Request("http://localhost/api/config/profiles");
    const listRes = await handleListProfiles(listReq, { db }, authorized);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{ id: string; hasKey: boolean }>;
    expect(list.length).toBe(1);
    expect(list[0]!.hasKey).toBe(true);
    expect((list[0] as Record<string, unknown>).apiKey).toBeUndefined();

    // Rejects invalid endpoint
    const badReq = new Request("http://localhost/api/config/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad",
        endpoint: "not-a-url",
        authField: "ANTHROPIC_AUTH_TOKEN",
      }),
    });
    expect((await handleCreateProfile(badReq, { db }, authorized)).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/control-server/src/routes/config-routes.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `config-routes.ts` and mount in `server.ts`**

Implement `handleListProfiles`, `handleGetProfile`, `handleCreateProfile`, `handleUpdateProfile`, `handleDeleteProfile`. Wire routes `/api/config/profiles` and `/api/config/profiles/:id` in `apps/control-server/src/server.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/control-server/src/routes/config-routes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/control-server/src/routes/config-routes.ts apps/control-server/src/routes/config-routes.test.ts apps/control-server/src/server.ts
git commit -m "feat(control-server): add /api/config/profiles CRUD routes"
```

---

### Task 4: Agent Adapter & Runner Execution (`packages/agent-adapter` & `apps/runner`)

**Files:**
- Modify: `packages/agent-adapter/src/index.ts`, `apps/runner/src/execution/executor.ts`
- Test: `packages/agent-adapter/src/index.test.ts`, `apps/runner/src/execution/executor.test.ts`

**Interfaces:**
- Consumes: `SdkStreamInput` with `env?: Record<string, string | undefined>` and `settings?: Record<string, unknown>`
- Produces: Populated `options.env` and `options.settings` in child query call without mutating `process.env`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/agent-adapter/src/index.test.ts (add test)
test("injects env overlay while spreading process.env and passes settings overlay", async () => {
  let capturedOptions: Record<string, unknown> | undefined;
  const fakeQuery = ((params: { options?: Record<string, unknown> }) => {
    capturedOptions = params.options;
    return (async function* () {})();
  }) as unknown as QueryFn;

  const stream = createSdkStream(
    {
      prompt: "test",
      cwd: "/tmp",
      env: { ANTHROPIC_BASE_URL: "http://192.168.2.3:20128", CUSTOM_VAR: "custom" },
      settings: { effortLevel: "high" },
    },
    () => fakeQuery,
  );

  for await (const _ of stream) {}

  expect(capturedOptions?.["env"]).toBeDefined();
  const env = capturedOptions?.["env"] as Record<string, string>;
  expect(env["ANTHROPIC_BASE_URL"]).toBe("http://192.168.2.3:20128");
  expect(env["CUSTOM_VAR"]).toBe("custom");
  expect(env["PATH"]).toBeDefined(); // Process env was spread

  expect(capturedOptions?.["settings"]).toMatchObject({ effortLevel: "high" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/agent-adapter/src/index.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement adapter and runner executor profile extraction**

1. In `packages/agent-adapter/src/index.ts`: Add `env` and `settings` to `SdkStreamInput`. When present, set `options["env"] = { ...process.env, ...input.env }` and merge `options["settings"]`.
2. In `apps/runner/src/execution/executor.ts`: If `record?.["profile"]` is present, construct overlay `env` mapping (`ANTHROPIC_BASE_URL`, auth token/key, `ANTHROPIC_DEFAULT_*_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`, plus `profile.settings?.env`) and forward to `options.sdk`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test packages/agent-adapter/src/index.test.ts && bun test apps/runner/src/execution/executor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent-adapter/src/index.ts packages/agent-adapter/src/index.test.ts apps/runner/src/execution/executor.ts apps/runner/src/execution/executor.test.ts
git commit -m "feat(runner): inject profile env and settings into SDK child query"
```

---

### Task 5: Run Dispatch Integration (`apps/control-server`)

**Files:**
- Modify: `apps/control-server/src/routes/runs-routes.ts`, `apps/control-server/src/dispatch/dispatcher.ts`
- Test: `apps/control-server/src/routes/runs-routes.test.ts`

**Interfaces:**
- Consumes: `profileId?: string` in `POST /api/sessions/:id/runs` request body; `getProfileWithSecret` from `@cc-web/control-db`
- Produces: `run.start` command payload with resolved `profile?: RunProfilePayload`

- [ ] **Step 1: Write the failing test**

```typescript
// in apps/control-server/src/routes/runs-routes.test.ts
test("resolves profileId and forwards RunProfilePayload in run.start payload", async () => {
  // Setup user, runner, session, and a profile
  const profile = createProfile(db, {
    ownerId: "owner-1",
    name: "9Router",
    endpoint: "http://192.168.2.3:20128",
    authField: "ANTHROPIC_AUTH_TOKEN",
    apiKey: "sk-secret-key",
    modelMapping: { sonnet: "prime" },
    settingsJson: "{}",
  });

  // Dispatch run with profileId
  const res = await app.request(`/api/sessions/${sessionId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "hello", profileId: profile.id }),
  });
  expect(res.status).toBe(202);

  // Verify command outbox / runner inbox receives payload with profile
  const sent = inbox.query("SELECT payload FROM command_inbox").all() as Array<{ payload: string }>;
  const parsed = JSON.parse(sent[0]!.payload);
  expect(parsed.profile).toBeDefined();
  expect(parsed.profile.endpoint).toBe("http://192.168.2.3:20128");
  expect(parsed.profile.apiKey).toBe("sk-secret-key");
  expect(parsed.profile.modelMapping.sonnet).toBe("prime");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/control-server/src/routes/runs-routes.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement profile resolution in `runs-routes.ts`**

If `record.profileId` is provided:
1. Fetch profile with secret using `getProfileWithSecret(options.db, record.profileId, authorized.userId)`. If not found, return 400 Bad Request (`unknown_profile`).
2. Construct `RunProfilePayload` and pass it into `scheduler.dispatch(...)` so it lands in `command.payload.profile`.

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/control-server/src/routes/runs-routes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/control-server/src/routes/runs-routes.ts apps/control-server/src/routes/runs-routes.test.ts
git commit -m "feat(control-server): resolve profileId to RunProfilePayload on run dispatch"
```

---

### Task 6: Profiles Frontend View (`/profiles`) (`apps/web`)

**Files:**
- Create: `apps/web/src/views/ProfilesView.vue`, `apps/web/src/features/profiles/profiles-logic.ts`, `apps/web/src/features/profiles/profiles-logic.test.ts`, `apps/web/src/services/profiles-api.ts`
- Modify: `apps/web/src/router/index.ts`, `apps/web/src/components/SessionRail.vue`
- Test: `apps/web/src/features/profiles/profiles-logic.test.ts`

**Interfaces:**
- Consumes: REST endpoints `/api/config/profiles[/:id]`
- Produces: Route `/profiles`, dual form + JSON editor logic with bidirectional sync

- [ ] **Step 1: Write the failing test for pure two-way sync logic**

```typescript
// apps/web/src/features/profiles/profiles-logic.test.ts
import { describe, expect, test } from "bun:test";
import { formToJson, jsonToForm, validateSettingsJson } from "./profiles-logic.ts";

describe("profiles two-way sync logic", () => {
  test("syncs visual form state to valid Claude Code settings JSON", () => {
    const form = {
      name: "9Router",
      endpoint: "http://192.168.2.3:20128",
      apiKey: "sk-test",
      authField: "ANTHROPIC_AUTH_TOKEN" as const,
      modelMapping: { sonnet: "prime", opus: "titan" },
    };
    const jsonStr = formToJson(form, { permissions: { defaultMode: "bypassPermissions" } });
    const parsed = JSON.parse(jsonStr);
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://192.168.2.3:20128");
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-test");
    expect(parsed.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("prime");
    expect(parsed.permissions.defaultMode).toBe("bypassPermissions");
  });

  test("syncs valid JSON state back to form fields", () => {
    const json = JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://my-proxy.com",
        ANTHROPIC_AUTH_TOKEN: "sk-xyz",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "nano",
      },
    });
    const form = jsonToForm(json);
    expect(form.endpoint).toBe("https://my-proxy.com");
    expect(form.apiKey).toBe("sk-xyz");
    expect(form.modelMapping.haiku).toBe("nano");
  });

  test("validates settings JSON syntax", () => {
    expect(validateSettingsJson("{ bad json }").valid).toBe(false);
    expect(validateSettingsJson('{"ok": true}').valid).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/web/src/features/profiles/profiles-logic.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `profiles-logic.ts`, `profiles-api.ts`, `ProfilesView.vue`, route, and SessionRail link**

1. Create `apps/web/src/features/profiles/profiles-logic.ts` with pure sync and validation logic.
2. Create `apps/web/src/services/profiles-api.ts` wrapping `/api/config/profiles`.
3. Create `apps/web/src/views/ProfilesView.vue` with profile list and split Form/JSON Editor.
4. Add `/profiles` route to `apps/web/src/router/index.ts`.
5. Add "Profiles" button in `SessionRail.vue`.

- [ ] **Step 4: Run test and web build to verify it passes**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/web/src/features/profiles/profiles-logic.test.ts && cd apps/web && bun run build`
Expected: PASS and build succeeds

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/profiles/ apps/web/src/services/profiles-api.ts apps/web/src/views/ProfilesView.vue apps/web/src/router/index.ts apps/web/src/components/SessionRail.vue
git commit -m "feat(web): add /profiles management page with two-way form/JSON editor"
```

---

### Task 7: Composer Integration & Session Selection (`apps/web`)

**Files:**
- Modify: `apps/web/src/components/ModelPickerPopover.vue`, `apps/web/src/features/composer/composer-storage.ts`, `apps/web/src/features/composer/composer-logic.ts`, `apps/web/src/components/Composer.vue`
- Test: `apps/web/src/features/composer/composer-storage.test.ts`, `apps/web/src/features/composer/composer-logic.test.ts`

**Interfaces:**
- Consumes: Profiles from `profiles-api.ts`, `ModelPickerPopover.vue`
- Produces: `profileId` state per session, mapped model display in popover, `profileId` inclusion in `StartRunRequest`

- [ ] **Step 1: Write the failing test**

```typescript
// in apps/web/src/features/composer/composer-logic.test.ts
test("includes profileId in StartRunRequest when selected", () => {
  const req = buildStartRunRequest({
    prompt: "hello",
    permission: "default",
    model: "sonnet",
    effort: null,
    ultracode: false,
    profileId: "prof_123",
  });
  expect(req.profileId).toBe("prof_123");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/web/src/features/composer/composer-logic.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement profile support in Composer**

1. In `composer-storage.ts`: add `profileId: string | null` to `ComposerSettings`.
2. In `composer-logic.ts`: forward `profileId` into `StartRunRequest`.
3. In `ModelPickerPopover.vue`: add Profile selector at top. When a profile is active, display mapped model names (e.g. `Sonnet (prime)`).
4. In `Composer.vue`: load profiles list, wire `v-model:profileId`, and pass into `submit()`.

- [ ] **Step 4: Run tests and web build to verify they pass**

Run: `export PATH="$HOME/.ponta/bin:$PATH" && bun test apps/web/src/features/composer/ && cd apps/web && bun run build`
Expected: PASS and build succeeds

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ModelPickerPopover.vue apps/web/src/features/composer/ apps/web/src/components/Composer.vue
git commit -m "feat(web): integrate profile selection into ModelPickerPopover and composer run dispatch"
```

---

### Task 8: End-to-End Integration Test & Full Suite Gates

**Files:**
- Create: `apps/control-server/src/dispatch/profile-run.test.ts`
- Test: Full project test suite

**Interfaces:**
- Consumes: Complete P3-C stack across control-server, runner, protocol, web
- Produces: Verified end-to-end run dispatch with profile overrides

- [ ] **Step 1: Write and run end-to-end integration test**

Verify that:
1. A profile is created via `config_profiles`.
2. A run is dispatched with that `profileId`.
3. The runner receives `run.start` with `RunProfilePayload`.
4. The executor calls SDK with `ANTHROPIC_BASE_URL` and model environment variables set.
5. The run finishes successfully.

- [ ] **Step 2: Run all repo verification gates**

```bash
export PATH="$HOME/.ponta/bin:$PATH"
bun test
bun run typecheck
bun run lint
cd apps/web && bun run build
```
Expected: All 1772+ tests pass, typecheck clean, lint clean, web build clean.

- [ ] **Step 3: Commit**

```bash
git add apps/control-server/src/dispatch/profile-run.test.ts
git commit -m "test: add end-to-end integration test for profile run execution"
```
