# Internationalization (i18n) & User Profile Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement bilingual support (Vietnamese & English) across `cc-web` and an interactive user menu in the navigation rail with profile editing (avatar upload, username change, password change).

**Architecture:**
- **Control DB & Server**: Add `avatar TEXT` to SQLite `users` table via idempotent migration. Extend `GET /api/me` and implement `PATCH /api/me` in `apps/control-server` with password re-hashing, token re-signing, and username uniqueness verification.
- **Frontend i18n**: Lightweight reactive i18n composable (`apps/web/src/lib/i18n/`) with `currentLocale` ('vi' | 'en'), localStorage persistence, dot-notation `t(key, params)` lookup, and graceful fallback (`en` -> `vi` -> bare key).
- **User Profile UI**: `UserProfileDialog.vue` with client-side canvas square crop/compression to base64 data URI (< 100KB), username editing, and optional password change.
- **Navigation Rail**: Interactive popover trigger in `SessionRail.vue` footer showing avatar image / initial, language switch buttons (`[🇻🇳 VN]` / `[🇺🇸 EN]`), profile modal trigger, and sign out.

**Tech Stack:** Vue 3 (SFC), TypeScript 7, Bun Test, SQLite (`bun:sqlite`), Tailwind CSS v4, shadcn-vue primitives.

**Spec:** `docs/superpowers/specs/2026-11-02-i18n-and-user-profile-design.md`

## Global Constraints

- **Never edit generated shadcn-vue files**: `apps/web/src/components/ui/**`, `apps/web/src/lib/utils.ts`, `apps/web/src/styles/index.css`, `apps/web/components.json`.
- **Theme integration**: Use generated CSS variables (`var(--background)`, `var(--border)`, `var(--primary)`, `var(--muted-foreground)`) or Tailwind utilities; dark theme matches `#09090b`.
- **Typecheck gate**: `bun run typecheck` runs `tsc -b`, apps/web tsc, and `scripts/typecheck-vue.ts` via `vue-tsgo`. SFC templates must not double-unwrap refs or access missing properties.
- **Verification gates**: Every task must pass `bun test`, `bun run typecheck`, and `bun run lint`.

## Review Focus

1. **Avatar image payload size**: Client-side canvas compression must limit avatar base64 data URI to < 100KB before upload to avoid SQLite bloat.
2. **Session continuity on password change**: When password is changed, `token_version` is bumped; `PATCH /api/me` must re-mint and send updated `cc_session` and `cc_refresh` cookies in response headers so the operator is not immediately logged out.
3. **Username collision handling**: `PATCH /api/me` must check username uniqueness (`WHERE username = ? AND id != ?`) and return HTTP 409 if taken.
4. **Reactive i18n without page reload**: Switching between `vi` and `en` must reactively update all translated labels immediately without requiring a browser refresh.
5. **i18n fallback safety**: If a translation key is missing in `en`, it must seamlessly fall back to `vi`; if missing in both, it must return the key string without throwing.

---

### Task 1: Database Migration for `avatar` Column in `packages/control-db`

**Files:**
- Modify: `packages/control-db/src/db.ts:33-43`
- Test: `packages/control-db/src/db.test.ts`

**Interfaces:**
- Produces:
  - `users` table with `avatar TEXT` column (nullable, defaults to `NULL`).
  - `addColumnIfMissing(db, "users", "avatar", "TEXT")` executed during `migrate(db)`.

- [ ] **Step 1: Write the failing test for `avatar` column in `packages/control-db/src/db.test.ts`**

```typescript
test("users carries the avatar column", () => {
  const db = new Database(":memory:");
  migrate(db);
  const columns = (db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  expect(columns).toContain("avatar");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/control-db/src/db.test.ts`
Expected: FAIL (column "avatar" not found in `users`).

- [ ] **Step 3: Add `avatar` column in `packages/control-db/src/db.ts`**

Update `users` table definition and migration:
```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    token_version INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL,
    avatar        TEXT
  );
`);
addColumnIfMissing(db, "users", "avatar", "TEXT");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/control-db/src/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full test suite and commit**

```bash
bun test packages/control-db
git add packages/control-db/src/db.ts packages/control-db/src/db.test.ts
git commit -m "feat(control-db): add avatar column to users table"
```

---

### Task 2: Backend `GET /api/me` and `PATCH /api/me` in `apps/control-server`

**Files:**
- Modify: `apps/control-server/src/routes/me-routes.ts`
- Modify: `apps/control-server/src/routes/me-routes.test.ts`
- Modify: `apps/control-server/src/server.ts:557-560`

**Interfaces:**
- Produces:
  - `handleMe(request, options, allowedOrigins, browserGateway)`: returns `{ username: string, avatar: string | null }`.
  - `handleUpdateMe(request, options, allowedOrigins, browserGateway)`: handles `PATCH /api/me`.
    - Accepts JSON: `{ username?: string, avatar?: string | null, currentPassword?: string, newPassword?: string }`.
    - Validates username regex `/^[a-zA-Z0-9_.-]{2,32}$/` and uniqueness.
    - If `newPassword` provided, validates `currentPassword` with `options.verifyPassword`, hashes `newPassword`, bumps `token_version` via `options.auth.invalidateUser`, mints new tokens, and sets `Set-Cookie` for `cc_session` and `cc_refresh`.
    - If `avatar` provided, validates base64 data URI format or null.
    - Updates SQLite and returns `{ ok: true, username: string, avatar: string | null }`.

- [ ] **Step 1: Write failing tests in `apps/control-server/src/routes/me-routes.test.ts`**

Add tests covering:
1. `GET /api/me` returns `avatar: null` when not set, or avatar string when set.
2. `PATCH /api/me` updates username successfully.
3. `PATCH /api/me` returns 409 Conflict if username already taken by another user.
4. `PATCH /api/me` updates avatar data URI and clears avatar with null.
5. `PATCH /api/me` with `newPassword` succeeds when `currentPassword` is valid and sets updated `Set-Cookie` headers.
6. `PATCH /api/me` with `newPassword` fails (400) when `currentPassword` is invalid.

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test apps/control-server/src/routes/me-routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `handleUpdateMe` and update `handleMe` in `apps/control-server/src/routes/me-routes.ts`**

Implement route handlers with:
- Origin and auth checks.
- Parameter validation.
- SQL queries updating `username`, `avatar`, and `password_hash`.
- Re-signing cookies when `token_version` changes.
- Mount `PATCH /api/me` in `apps/control-server/src/server.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/control-server/src/routes/me-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Run control-server test suite and commit**

```bash
bun test apps/control-server
git add apps/control-server/src/routes/me-routes.ts apps/control-server/src/routes/me-routes.test.ts apps/control-server/src/server.ts
git commit -m "feat(control-server): add PATCH /api/me for updating username, password, and avatar"
```

---

### Task 3: Frontend i18n Core Module & Translation Dictionaries

**Files:**
- Create: `apps/web/src/lib/i18n/types.ts`
- Create: `apps/web/src/lib/i18n/locales/vi.ts`
- Create: `apps/web/src/lib/i18n/locales/en.ts`
- Create: `apps/web/src/lib/i18n/index.ts`
- Create: `apps/web/src/lib/i18n/i18n.test.ts`

**Interfaces:**
- Produces:
  - `type Locale = 'vi' | 'en'`
  - `type TranslationDictionary = { ... }`
  - `currentLocale: Ref<Locale>`
  - `setLocale(locale: Locale): void`: updates reactive ref and `localStorage.setItem('cc-web:locale', locale)`.
  - `t(key: string, params?: Record<string, string | number>): string`: dot-notation accessor with fallback: `currentLocale` -> `vi` -> key.
  - `useI18n()`: returns `{ locale: currentLocale, setLocale, t }`.

- [ ] **Step 1: Write failing tests in `apps/web/src/lib/i18n/i18n.test.ts`**

```typescript
import { describe, expect, test, beforeEach } from "bun:test";
import { currentLocale, setLocale, t } from "./index.ts";

describe("i18n module", () => {
  beforeEach(() => {
    setLocale("vi");
  });

  test("returns Vietnamese string when locale is vi", () => {
    expect(t("common.save")).toBe("Lưu");
  });

  test("reactively updates translation when locale changes to en", () => {
    setLocale("en");
    expect(t("common.save")).toBe("Save");
  });

  test("replaces named parameters in translation strings", () => {
    expect(t("common.pageCount", { current: 1, total: 5 })).toBe("Trang 1 / 5");
    setLocale("en");
    expect(t("common.pageCount", { current: 1, total: 5 })).toBe("Page 1 of 5");
  });

  test("falls back to vi when key is missing in en", () => {
    setLocale("en");
    expect(t("common.save")).toBe("Save");
  });

  test("returns raw key string when missing in all locales", () => {
    expect(t("nonexistent.key")).toBe("nonexistent.key");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test apps/web/src/lib/i18n/i18n.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `types.ts`, `locales/vi.ts`, `locales/en.ts`, and `index.ts`**

Build:
- Dictionaries with categories: `common`, `rail`, `user`, `profiles`, `runners`, `dashboard`, `session`.
- Reactive lookup function supporting `{param}` substitution and `localStorage` persistence.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/web/src/lib/i18n/i18n.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit i18n foundation**

```bash
git add apps/web/src/lib/i18n
git commit -m "feat(web): add reactive bilingual i18n module (vi/en)"
```

---

### Task 4: User Profile API Client & Store Integration

**Files:**
- Modify: `apps/web/src/stores/sessions.ts:40-85`
- Create: `apps/web/src/services/user-api.ts`
- Create: `apps/web/src/services/user-api.test.ts`

**Interfaces:**
- Produces:
  - `sessions.avatar: string | null` in `SessionsStore`.
  - `updateUserProfile(payload: UpdateMePayload): Promise<UpdateMeResponse>` in `user-api.ts`.
  - `loadAccount()` populates both `sessions.account` and `sessions.avatar`.

- [ ] **Step 1: Write failing test in `apps/web/src/services/user-api.test.ts`**

Test payload sending, headers, and parsing for `PATCH /api/me`.

- [ ] **Step 2: Run test to verify failure**

Run: `bun test apps/web/src/services/user-api.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `user-api.ts` and update `sessions.ts`**

Update `sessions.ts` to hold `avatar: string | null`, populate it in `loadAccount()`, and export `updateUserProfile` helper.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/services/user-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit store and API client**

```bash
git add apps/web/src/stores/sessions.ts apps/web/src/services/user-api.ts apps/web/src/services/user-api.test.ts
git commit -m "feat(web): add user profile API service and store avatar state"
```

---

### Task 5: User Profile Dialog & Avatar Processing Helpers

**Files:**
- Create: `apps/web/src/components/profiles/user-profile-helpers.ts`
- Create: `apps/web/src/components/profiles/user-profile-helpers.test.ts`
- Create: `apps/web/src/components/profiles/UserProfileDialog.vue`

**Interfaces:**
- Produces:
  - `validateUsername(username: string): { valid: boolean; error?: string }`
  - `validatePasswordChange(current: string, next: string, confirm: string): { valid: boolean; error?: string }`
  - `downscaleAvatarImage(file: File, maxDim?: number): Promise<string>`: creates square canvas, resizes to <= 256x256, returns JPEG base64 (< 100KB).
  - `<UserProfileDialog v-model:open="isOpen" />`: Modal with avatar preview/upload/delete, username input, password change inputs, and submit action.

- [ ] **Step 1: Write failing tests for profile helpers in `user-profile-helpers.test.ts`**

Test validation rules for usernames (length 2-32, characters) and passwords (min length 8, matching confirmation).

- [ ] **Step 2: Run test to verify failure**

Run: `bun test apps/web/src/components/profiles/user-profile-helpers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `user-profile-helpers.ts` and `UserProfileDialog.vue`**

Implement validation logic, client-side canvas crop/compression, and dialog SFC using shadcn Dialog, Input, Label, and Button components with `$t` translation keys.

- [ ] **Step 4: Run test to verify helpers pass**

Run: `bun test apps/web/src/components/profiles/user-profile-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck and commit**

```bash
bun run typecheck
git add apps/web/src/components/profiles/user-profile-helpers.ts apps/web/src/components/profiles/user-profile-helpers.test.ts apps/web/src/components/profiles/UserProfileDialog.vue
git commit -m "feat(web): add UserProfileDialog and avatar image processing helpers"
```

---

### Task 6: SessionRail User Menu, Avatar Display, and Language Switcher

**Files:**
- Modify: `apps/web/src/components/SessionRail.vue`

**Interfaces:**
- Produces:
  - User trigger in `SessionRail.vue` footer:
    - If `sessions.avatar` exists: renders circular avatar image `<img :src="sessions.avatar" class="size-6 rounded-full object-cover" />`.
    - Else: renders uppercase initial letter fallback.
    - Username text and popover indicator.
  - Popover content:
    - Quick language switch row: `[🇻🇳 VN]` and `[🇺🇸 EN]` buttons with active state highlighting.
    - "Chỉnh sửa tài khoản" / "Edit Profile" button opening `UserProfileDialog`.
    - "Đăng xuất" / "Log out" button.
  - Embeds `<UserProfileDialog v-model:open="profileDialogOpen" />`.

- [ ] **Step 1: Update `SessionRail.vue` footer with Popover and UserProfileDialog**

Replace static account footer with Popover trigger and menu content. Wire up `useI18n()` for `currentLocale` and `setLocale`.

- [ ] **Step 2: Run typecheck and lint to verify template syntax**

Run: `bun run typecheck && bun run lint`
Expected: Clean.

- [ ] **Step 3: Commit SessionRail user menu**

```bash
git add apps/web/src/components/SessionRail.vue
git commit -m "feat(web): add user popover menu with avatar and language switcher in SessionRail"
```

---

### Task 7: Internationalize Navigation Rail & Key App Views

**Files:**
- Modify: `apps/web/src/components/SessionRail.vue`
- Modify: `apps/web/src/views/ConsoleLayout.vue`
- Modify: `apps/web/src/views/ProfilesView.vue`
- Modify: `apps/web/src/views/RunnersView.vue`
- Modify: `apps/web/src/views/DashboardView.vue`

**Interfaces:**
- Produces:
  - Replaces hardcoded Vietnamese strings in rail headers, search placeholders, empty states, and view tab labels with `t(...)`.

- [ ] **Step 1: Replace hardcoded strings in `SessionRail.vue` and `ConsoleLayout.vue` with `t(...)`**

Use keys: `rail.sessions`, `rail.newSession`, `rail.searchPlaceholder`, `rail.noSessions`, `rail.profiles`, `rail.runners`, `rail.dashboard`.

- [ ] **Step 2: Replace hardcoded strings in `ProfilesView.vue`, `RunnersView.vue`, and `DashboardView.vue`**

Wire translation keys for main section titles, action buttons (Save, Delete, Refresh, Create), and common status notices.

- [ ] **Step 3: Run full verification suite**

Run: `bun test && bun run typecheck && bun run lint && cd apps/web && bun run build`
Expected: ALL PASS.

- [ ] **Step 4: Commit translation wiring**

```bash
git add apps/web/src/components/SessionRail.vue apps/web/src/views/ConsoleLayout.vue apps/web/src/views/ProfilesView.vue apps/web/src/views/RunnersView.vue apps/web/src/views/DashboardView.vue
git commit -m "feat(web): wire bilingual translation keys across rail and primary views"
```

---

### Task 8: Full Verification and End-to-End Build Gate

**Files:**
- None (verification pass).

- [ ] **Step 1: Run complete test suite across all packages**

Run: `bun test`
Expected: PASS (all 2013+ tests pass).

- [ ] **Step 2: Run full typecheck gate**

Run: `bun run typecheck`
Expected: Clean (`tsc -b`, apps/web tsc, `vue-tsgo`).

- [ ] **Step 3: Run Biome lint**

Run: `bun run lint`
Expected: Clean.

- [ ] **Step 4: Run web production build**

Run: `cd apps/web && bun run build`
Expected: Build succeeds without errors.
