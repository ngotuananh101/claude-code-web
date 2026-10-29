# First-time Setup & Authenticated WebSocket Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a one-time initial admin account setup flow on fresh deployments when no users exist, and ensure browser WebSockets only connect after authentication and disconnect on logout.

**Architecture:**
- Control server exposes `GET /auth/setup-status` and transactional `POST /auth/setup` with Origin verification, argon2id password hashing, and instant session cookie minting.
- Web client manages socket lifecycle explicitly with `connect()` and `disconnect()` in `SocketService`, wiring lifecycle to router navigation guards and auth events.
- Vue router guards intercept unauthenticated visitors to `/setup` if setup is required, prevent access to `/setup` once completed, and prevent unauthenticated WebSocket churn.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, Vue 3, Vue Router, Tailwind CSS, shadcn-vue.

**Spec:** Direct feature request & ADR-0001 JWT Auth specifications.

## Global Constraints

- Không bao giờ sửa / lint / format các file sinh ra của shadcn-vue (`apps/web/src/components/ui/**`, `apps/web/src/lib/utils.ts`, `apps/web/src/styles/index.css`, `apps/web/components.json`).
- Biome generated-file protection override must stay last in `biome.json`.
- All technical code, identifiers, commit messages, and tests must be in English; user-facing UI text in Vietnamese.
- Full test suite must pass (`bun test`, `bun run typecheck`, `bun run lint`, `cd apps/web && bun run build`).

## Review Focus

1. Concurrency: Two requests hitting `POST /auth/setup` at the same time on a fresh database must be serialized via transaction so only one creates the owner, and the other receives 403 Forbidden.
2. Socket churn: An unauthenticated visitor sitting on `/login` or `/setup` must never trigger WebSocket reconnect attempts or spam `/ws/browser`.
3. Post-setup lock: Once setup is completed, any subsequent call to `POST /auth/setup` or navigation to `/setup` is refused and redirected to `/login` (or `/` if already authorized).
4. Auto-login on setup: After `POST /auth/setup` succeeds, the client receives a valid `Set-Cookie: cc_session=...` and can immediately query `/api/sessions` without needing to log in again.
5. Input validation: Setup with empty/whitespace username or invalid password is rejected on client and server with 400 Bad Request.

---

### Task 1: Server-Side First-Time Setup Endpoints & Tests

**Files:**
- Modify: `apps/control-server/src/routes/auth-routes.ts`
- Create: `apps/control-server/src/routes/auth-routes.test.ts`
- Modify: `apps/control-server/src/server.ts`
- Modify: `apps/control-server/src/config.ts`

**Interfaces:**
- Produces:
  - `handleSetupStatus(request: Request, options: ServerOptions): Response` returning `{ setupRequired: boolean }`
  - `handleSetup(request: Request, options: ServerOptions, allowedOrigins: ReadonlySet<string>): Promise<Response>` returning `{ ok: true, user: { id: string, username: string } }` with `Set-Cookie` header on success, or 403 when users already exist.
  - `ServerOptions.hashPassword?: (plain: string) => Promise<string>`

- [ ] **Step 1: Write failing tests in `apps/control-server/src/routes/auth-routes.test.ts`**

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "@cc-web/control-db";
import { AuthService } from "../auth/auth-service.ts";
import { createSigner } from "../auth/tokens.ts";
import { handleSetup, handleSetupStatus } from "./auth-routes.ts";

describe("auth setup endpoints", () => {
  test("GET /auth/setup-status returns setupRequired: true on fresh DB", () => { ... });
  test("GET /auth/setup-status returns setupRequired: false when users exist", () => { ... });
  test("POST /auth/setup creates the first user and sets session cookie", async () => { ... });
  test("POST /auth/setup refuses if users already exist (403)", async () => { ... });
  test("POST /auth/setup validates origin and rejects foreign origin", async () => { ... });
  test("POST /auth/setup validates input parameters", async () => { ... });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/control-server/src/routes/auth-routes.test.ts`
Expected: FAIL (functions not exported/implemented)

- [ ] **Step 3: Implement `handleSetupStatus` and `handleSetup` in `apps/control-server/src/routes/auth-routes.ts`, and wire in `server.ts` & `config.ts`**

Implement:
- `handleSetupStatus`: query `SELECT COUNT(*) as count FROM users` and return `{ setupRequired: count === 0 }`.
- `handleSetup`: check origin against `allowedOrigins`; parse body `{ username, password }`; validate non-empty trimmed username and password; transactionally insert owner user if `count === 0`, else return 403; issue access token and set `cc_session` cookie.
- Update `ServerOptions` to include `hashPassword?: (plain: string) => Promise<string>` and route `/auth/setup-status` and `/auth/setup` in `server.ts`.
- In `config.ts`, pass `hashPassword` from `./auth/password.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/control-server/src/routes/auth-routes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/control-server/src/routes/auth-routes.ts apps/control-server/src/routes/auth-routes.test.ts apps/control-server/src/server.ts apps/control-server/src/config.ts
git commit -m "feat(server): add setup-status and setup endpoints for first-time deploy"
```

---

### Task 2: Web WebSocket Lifecycle Management & Tests

**Files:**
- Modify: `apps/web/src/services/socket.ts`
- Create: `apps/web/src/services/socket.test.ts`
- Modify: `apps/web/src/stores/sessions.ts`
- Modify: `apps/web/src/stores/sessions.test.ts`
- Modify: `apps/web/src/App.vue`

**Interfaces:**
- Produces:
  - `socket.connect(): void` — sets enabled = true, connects if not already active
  - `socket.disconnect(): void` — sets enabled = false, clears reconnect timer, closes active ws, sets state to "closed"
  - `connectSocket(): void` and `disconnectSocket(): void` exported from `apps/web/src/stores/sessions.ts`

- [ ] **Step 1: Write failing tests in `apps/web/src/services/socket.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { socket } from "./socket.ts";

describe("SocketService lifecycle", () => {
  test("initial state is closed and does not connect automatically", () => { ... });
  test("disconnect clears reconnect timer and sets state to closed", () => { ... });
  test("close event does not reconnect if disconnected by user", () => { ... });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/services/socket.test.ts`
Expected: FAIL (missing methods or state assertion failure)

- [ ] **Step 3: Implement lifecycle methods in `socket.ts` and update `sessions.ts`**

- In `socket.ts`:
  - Initialize `#state = "closed"`.
  - Add `#enabled = false` and `#reconnectTimer: ReturnType<typeof setTimeout> | null = null`.
  - In `connect()`: set `#enabled = true`. If already connected or connecting, return early.
  - In `disconnect()`: set `#enabled = false`; cancel `#reconnectTimer`; close `#ws` if open; set state to `"closed"`.
  - In `ws.close`: only schedule reconnect if `this.#enabled` is true.
- In `sessions.ts`:
  - Remove `socket.connect()` from `startStore()`.
  - Export `connectSocket(): void { socket.connect(); }`.
  - Export `disconnectSocket(): void { socket.disconnect(); }`.
  - Initialize `sessions.connection = "closed"`.
- In `App.vue`: keep `startStore()` which now only binds event listeners without connecting socket.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/web/src/services/socket.test.ts apps/web/src/stores/sessions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/socket.ts apps/web/src/services/socket.test.ts apps/web/src/stores/sessions.ts apps/web/src/stores/sessions.test.ts apps/web/src/App.vue
git commit -m "feat(web): manage WebSocket lifecycle with explicit connect and disconnect"
```

---

### Task 3: Web Auth API Service & Setup Logic

**Files:**
- Create: `apps/web/src/services/auth-api.ts`
- Create: `apps/web/src/services/auth-api.test.ts`
- Create: `apps/web/src/features/setup/setup-logic.ts`
- Create: `apps/web/src/features/setup/setup-logic.test.ts`

**Interfaces:**
- Produces:
  - `fetchSetupStatus(): Promise<{ setupRequired: boolean }>`
  - `submitSetup(payload: { username: string; password: string }): Promise<{ ok: true } | { ok: false; message: string }>`
  - `validateSetupForm(form: SetupFormData): { valid: boolean; error?: string }`
  - `createSetupController(...)`: state and actions for the setup screen

- [ ] **Step 1: Write failing tests for `auth-api.test.ts` and `setup-logic.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { fetchSetupStatus, submitSetup } from "./auth-api.ts";
import { validateSetupForm } from "../features/setup/setup-logic.ts";

describe("auth-api and setup-logic", () => {
  test("validateSetupForm rejects empty username", () => { ... });
  test("validateSetupForm rejects empty or short password", () => { ... });
  test("validateSetupForm rejects mismatched passwords", () => { ... });
  test("validateSetupForm accepts valid credentials", () => { ... });
  test("submitSetup sends request and returns result", async () => { ... });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/services/auth-api.test.ts apps/web/src/features/setup/setup-logic.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `auth-api.ts` and `setup-logic.ts`**

- `auth-api.ts`:
  - `fetchSetupStatus()` calls `GET /auth/setup-status`.
  - `submitSetup({ username, password })` calls `POST /auth/setup`.
- `setup-logic.ts`:
  - Pure validation logic:
    - Username cannot be empty after trimming.
    - Password must be at least 6 characters.
    - Confirm password must match password.
    - Error messages formatted in Vietnamese (e.g., "Tên đăng nhập không được để trống", "Mật khẩu phải có ít nhất 6 ký tự", "Mật khẩu xác nhận không khớp").

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/services/auth-api.test.ts apps/web/src/features/setup/setup-logic.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/auth-api.ts apps/web/src/services/auth-api.test.ts apps/web/src/features/setup/setup-logic.ts apps/web/src/features/setup/setup-logic.test.ts
git commit -m "feat(web): add auth API service and setup validation logic"
```

---

### Task 4: Navigation Guard & Routing for Setup & Auth

**Files:**
- Create: `apps/web/src/router/navigation-guard.ts`
- Create: `apps/web/src/router/navigation-guard.test.ts`
- Modify: `apps/web/src/router/index.ts`

**Interfaces:**
- Produces:
  - `evaluateNavigation(params: { toPath: string; isAuthorized: boolean; isSetupRequired: boolean }): { redirect?: string; allow: boolean; socketAction: "connect" | "disconnect" }`
  - `/setup` route in `router/index.ts`

- [ ] **Step 1: Write failing tests in `apps/web/src/router/navigation-guard.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { evaluateNavigation } from "./navigation-guard.ts";

describe("evaluateNavigation", () => {
  test("redirects to /setup when setup is required, disconnecting socket", () => {
    expect(evaluateNavigation({ toPath: "/", isAuthorized: false, isSetupRequired: true }))
      .toEqual({ redirect: "/setup", allow: false, socketAction: "disconnect" });
    expect(evaluateNavigation({ toPath: "/login", isAuthorized: false, isSetupRequired: true }))
      .toEqual({ redirect: "/setup", allow: false, socketAction: "disconnect" });
    expect(evaluateNavigation({ toPath: "/setup", isAuthorized: false, isSetupRequired: true }))
      .toEqual({ allow: true, socketAction: "disconnect" });
  });

  test("redirects /setup to /login when setup is not required and unauthorized", () => {
    expect(evaluateNavigation({ toPath: "/setup", isAuthorized: false, isSetupRequired: false }))
      .toEqual({ redirect: "/login", allow: false, socketAction: "disconnect" });
  });

  test("allows /login when unauthorized and setup is not required", () => {
    expect(evaluateNavigation({ toPath: "/login", isAuthorized: false, isSetupRequired: false }))
      .toEqual({ allow: true, socketAction: "disconnect" });
  });

  test("redirects protected route to /login when unauthorized and setup is not required", () => {
    expect(evaluateNavigation({ toPath: "/runners", isAuthorized: false, isSetupRequired: false }))
      .toEqual({ redirect: "/login", allow: false, socketAction: "disconnect" });
  });

  test("connects socket and allows protected routes when authorized", () => {
    expect(evaluateNavigation({ toPath: "/", isAuthorized: true, isSetupRequired: false }))
      .toEqual({ allow: true, socketAction: "connect" });
    expect(evaluateNavigation({ toPath: "/login", isAuthorized: true, isSetupRequired: false }))
      .toEqual({ redirect: "/", allow: false, socketAction: "connect" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/router/navigation-guard.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `evaluateNavigation` and wire router guard in `apps/web/src/router/index.ts`**

- In `navigation-guard.ts`: implement rule table as defined in step 1.
- In `index.ts`:
  - Add `{ path: "/setup", component: () => import("../views/SetupView.vue") }` route.
  - In `router.beforeEach`:
    - First check authorization via `await loadSessions()`.
    - If not authorized, check `await fetchSetupStatus()`.
    - Run `evaluateNavigation({ toPath: to.path, isAuthorized, isSetupRequired })`.
    - If `decision.socketAction === "connect"`, call `connectSocket()`.
    - If `decision.socketAction === "disconnect"`, call `disconnectSocket()`.
    - If `decision.redirect`, return `decision.redirect`.
    - If `isAuthorized`, trigger `loadAccount()`.
    - Return `true`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/router/navigation-guard.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/router/navigation-guard.ts apps/web/src/router/navigation-guard.test.ts apps/web/src/router/index.ts
git commit -m "feat(web): implement setup and auth navigation guard with socket lifecycle"
```

---

### Task 5: SetupView UI & Component Integration

**Files:**
- Create: `apps/web/src/views/SetupView.vue`
- Modify: `apps/web/src/views/LoginView.vue`
- Modify: `apps/web/src/components/SessionRail.vue`

**Interfaces:**
- Produces:
  - `apps/web/src/views/SetupView.vue` component with form (username, password, confirmPassword), loading state, toast errors, and redirection to `/`.
  - `SessionRail.vue` calls `disconnectSocket()` on `signOut()`.

- [ ] **Step 1: Create `apps/web/src/views/SetupView.vue`**

Create `SetupView.vue` matching `LoginView.vue` visual structure:
- Branding header: `cc-web`.
- Title: "Thiết lập hệ thống".
- Subtitle: "Khởi tạo tài khoản quản trị đầu tiên cho hệ thống cc-web.".
- Form inputs:
  - Username: `id="username"`, `placeholder="Tên đăng nhập"`.
  - Password: `id="password"`, `type="password"`, `placeholder="Mật khẩu"`.
  - Confirm Password: `id="confirm-password"`, `type="password"`, `placeholder="Xác nhận mật khẩu"`.
- Button: "Khởi tạo tài khoản", with loading/disabled state.
- Submit handler: validates with `validateSetupForm()`, calls `submitSetup()`, on success toasts success and navigates to `"/"`.

- [ ] **Step 2: Update `LoginView.vue` and `SessionRail.vue`**

- In `LoginView.vue`:
  - After successful `/auth/login`, call `connectSocket()` before `router.push("/")`.
- In `SessionRail.vue`:
  - In `signOut()`: call `disconnectSocket()` to cleanly terminate socket before redirecting to `/login`.

- [ ] **Step 3: Run full verification suite**

Run:
```bash
bun test
bun run typecheck
bun run lint
cd apps/web && bun run build
```
Expected: All pass cleanly.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/views/SetupView.vue apps/web/src/views/LoginView.vue apps/web/src/components/SessionRail.vue
git commit -m "feat(web): add SetupView and wire auth actions to socket lifecycle"
```

---

### Task 6: Full Integration Smoke & Build Verification

**Files:**
- Verify all changes across server and web.

- [ ] **Step 1: Run comprehensive tests**

Run: `bun test`
Expected: 1244+ tests passing, 0 failing.

- [ ] **Step 2: Run typecheck and linting**

Run:
```bash
bun run typecheck
bun run lint
```
Expected: Clean with 0 errors.

- [ ] **Step 3: Run web production build**

Run: `cd apps/web && bun run build`
Expected: Succeeded.
