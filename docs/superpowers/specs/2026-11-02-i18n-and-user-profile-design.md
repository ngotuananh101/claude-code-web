# Internationalization (i18n) & User Profile Management Design

Status: Draft for review, 2026-11-02.

## 1. Intent & Problem Statement

Currently, `cc-web` hardcodes Vietnamese strings across its navigation rail, view headers, forms, dialogs, and notifications. Operators who prefer or require English cannot toggle the interface language.
Furthermore, the user representation in the sidebar footer (`SessionRail.vue`) is static:
- It only displays an initial letter and username with a direct sign-out button.
- Operators have no user-facing interface to update their username, change their password, or upload a custom avatar.
- Seeded accounts can only be modified via CLI scripts (`bun scripts/seed-user.ts`) or manual database updates.

This design introduces:
1. **Lightweight, reactive Internationalization (i18n)** supporting **Tiếng Việt (vi)** and **English (en)**, persisted in browser storage and reactive across the entire UI.
2. **Interactive User Menu Popover** in `SessionRail.vue` offering immediate language toggling, access to profile management, and logout.
3. **User Profile Modal & Control Server API (`PATCH /api/me`)** allowing operators to update their username, change their password (with current password verification), and upload or remove an avatar image.

---

## 2. Goals

- **Bilingual Interface (vi & en)**: Operators can seamlessly switch between Vietnamese and English at any time without page reloads.
- **Persistence**: Selected language is persisted in `localStorage` (`cc-web:locale`) and defaults intelligently (stored preference -> browser language -> fallback `vi`).
- **Interactive User Menu**: The footer of `SessionRail.vue` becomes an interactive trigger opening a clean popover menu with language switches, profile settings, and logout.
- **Avatar Support**: Operators can upload an avatar image (JPEG/PNG/WebP, resized and encoded as compact base64 or stored), displayed in the rail and user menu, falling back to account initial when unset.
- **Account Management**: Operators can update their `username` and `password` safely via a dedicated modal dialog with input validation and feedback.
- **Backend API & Security**:
  - `GET /api/me` returns `{ username: string, avatar: string | null }`.
  - `PATCH /api/me` validates credentials (requiring `currentPassword` when changing password), enforces unique usernames, updates the database, and handles session token versioning smoothly without logging out the current user.
- **Maintain Invariants**: Follow all rules in `CLAUDE.md`, strictly avoid editing generated files under `apps/web/src/components/ui/**`, and ensure all tests (`bun test`, `bun run typecheck`, `bun run lint`) pass cleanly.

---

## 3. Non-Goals

- External i18n cloud services or dynamic translation fetching from remote servers: translation dictionaries (`vi`, `en`) are bundled with the web app for speed and offline availability.
- Multi-tenant RBAC or complex permission systems: `cc-web` maintains its single-owner/operator control plane architecture (ADR-0001).
- Cloud image hosting / S3 storage for avatars: avatars are stored directly in SQLite as compact data URIs (< 100KB after client-side downscaling) or local storage.

---

## 4. Architecture & Technical Specification

### 4.1 Frontend i18n Module (`apps/web/src/lib/i18n/`)

A lightweight, reactive, type-safe translation composable:
- **Structure**:
  - `apps/web/src/lib/i18n/index.ts`: Core reactive state (`currentLocale`), `setLocale(locale: 'vi' | 'en')`, `t(key: string, params?: Record<string, string | number>)` translation function, and `useI18n()` composable.
  - `apps/web/src/lib/i18n/locales/vi.ts`: Vietnamese dictionary (default & primary fallback).
  - `apps/web/src/lib/i18n/locales/en.ts`: English dictionary.
  - `apps/web/src/lib/i18n/types.ts`: TypeScript definition ensuring key parity between dictionaries.
- **Key Syntax & Fallback**:
  - Dot-notation keys: e.g. `t('common.save')`, `t('rail.newSession')`, `t('user.changePassword')`.
  - Fallback logic: if a key is not found in `en`, falls back to `vi`. If missing in both, returns the bare key string without throwing.
- **Key Categories**:
  - `common`: `save`, `cancel`, `delete`, `edit`, `confirm`, `loading`, `close`, `error`, `success`, `refresh`.
  - `rail`: `sessions`, `profiles`, `runners`, `dashboard`, `newSession`, `search`, `emptySessions`, `activeRuns`, `recent`.
  - `user`: `profile`, `account`, `changePassword`, `currentPassword`, `newPassword`, `confirmPassword`, `avatar`, `uploadAvatar`, `removeAvatar`, `username`, `logout`, `language`.
  - `views`: translations for Console, Profiles, Runners, Dashboard views.

### 4.2 Control DB & Server API

#### Database Migration (`packages/control-db/src/db.ts`)
- Add `avatar TEXT` column to `users` table:
  ```sql
  ALTER TABLE users ADD COLUMN avatar TEXT;
  ```
  Executed inside database initialization if column doesn't exist. Defaults to `NULL`, which cleanly falls back to rendering the account's uppercase initial.

#### Server Route (`apps/control-server/src/routes/me-routes.ts`)
1. **`GET /api/me`**:
   - Queries `id, username, avatar FROM users WHERE id = ?`.
   - Returns `{ username: string, avatar: string | null }`.
2. **`PATCH /api/me`**:
   - Authenticated via browser session cookie.
   - Accepts JSON payload:
     ```ts
     interface UpdateMePayload {
       username?: string;
       avatar?: string | null;
       currentPassword?: string;
       newPassword?: string;
     }
     ```
   - **Validation & Logic**:
     - If `username` provided:
       - Validate charset: `/^[a-zA-Z0-9_.-]{2,32}$/`.
       - Check uniqueness: `SELECT id FROM users WHERE username = ? AND id != ?`. If collision, return 409 Conflict with `{ ok: false, error: "Username already taken" }`.
       - Update row in SQLite. `token_version` is NOT bumped (session remains valid).
     - If `newPassword` provided:
       - Require `currentPassword`; verify against current `password_hash` via `verifyPassword`. If invalid, return 400 with `{ ok: false, error: "Mật khẩu hiện tại không đúng" }`.
       - Validate `newPassword`: minimum length 8 characters.
       - Hash `newPassword` via `hashPassword`.
       - Increment `token_version` by 1 (revoking other active sessions per ADR-0001).
       - Issue an updated `cc_session` cookie in the response `Set-Cookie` header using `authService.mintSessionToken` so the current user's session remains continuous.
     - If `avatar` provided:
       - `null` or `""` clears avatar (`NULL` in DB).
       - String must be a valid image data URI (`data:image/(png|jpeg|webp);base64,...`), payload size <= 256KB.
     - Returns `{ ok: true, username: row.username, avatar: row.avatar }`.

### 4.3 SessionRail User Menu (`apps/web/src/components/SessionRail.vue`)

- Replace footer with a Popover trigger:
  - Trigger displays user avatar circle (if image exists, renders `<img>` with circular crop; else uppercase initial `accountInitial`), username, and vertical ellipsis icon.
  - Clicking trigger opens Popover menu.
  - Popover contents:
    - **Language Switcher Row**: Two buttons `[🇻🇳 VN]` and `[🇺🇸 EN]`. Active locale is highlighted. Clicking immediately updates `currentLocale` and writes to `localStorage`.
    - **Edit Profile Option**: Clicking closes the popover and opens `UserProfileDialog.vue` as a modal overlay (no URL route change).
    - **Sign Out**: Red-accented sign out action calling `signOut()`.

### 4.4 User Profile Dialog (`UserProfileDialog.vue`)

- **Avatar Section**:
  - Displays circular preview (64x64px).
  - "Tải ảnh lên" (Upload image) file picker (`accept="image/png,image/jpeg,image/webp"`).
  - Client-side canvas compression: scales and centers image into a square 256x256 max, exported as JPEG (quality 0.85) or WebP base64 data URI (guaranteed < 100KB).
  - "Xóa ảnh" (Remove image) button visible when an avatar is present, setting `avatar` to `null`.
- **Username Section**:
  - Input field prepopulated with current username, validated (`/^[a-zA-Z0-9_.-]{2,32}$/`).
- **Change Password Section**:
  - Collapsible / expandable section: "Đổi mật khẩu" / "Change password".
  - Fields: `Current password`, `New password`, `Confirm new password`.
- **Feedback & Actions**:
  - Clear validation error messages.
  - Save button with spinner.
  - Success toast upon update; updates session state immediately.

---

## 5. Implementation Phases

1. **Phase 1: Backend Profile API**:
   - Add `avatar` column to `users` table in `packages/control-db`.
   - Implement `PATCH /api/me` in `apps/control-server/src/routes/me-routes.ts`.
   - Add comprehensive unit tests in `me-routes.test.ts`.
2. **Phase 2: Frontend i18n Foundation**:
   - Create `apps/web/src/lib/i18n/` with dictionary structure (`vi`, `en`) and reactive helpers.
   - Unit test i18n logic.
3. **Phase 3: User Profile Modal & User Menu**:
   - Build `UserProfileDialog.vue` with avatar resizing and form validations.
   - Update `SessionRail.vue` with User Menu popover, language switcher, and avatar indicator.
4. **Phase 4: Key Views Translation**:
   - Wire up translation keys across `SessionRail.vue`, `ConsoleLayout.vue`, `ProfilesView.vue`, `RunnersView.vue`, and dialogs.
5. **Phase 5: Verification & Gate Checks**:
   - Run `bun test`, `bun run typecheck`, `bun run lint`, and `bun run build`.

---

## 6. Review Focus Areas

1. **Avatar Payload Size**: Ensure client-side image downscaling limits base64 string to < 100KB to prevent bloated database rows.
2. **Password Change Token Revocation**: When `token_version` increments on password update, the response must re-mint a valid session cookie so the user isn't logged out immediately.
3. **Username Collision**: Ensure `PATCH /api/me` checks that a new username does not collide with another user and returns a clean 409 status.
4. **Reactive Locale Switch**: Verify that toggling between `vi` and `en` immediately updates all labels without requiring a page refresh.
5. **Fallbacks for Missing Keys**: If a key is missing in one dictionary, fallback cleanly to the other language without crashing or showing blank labels.
