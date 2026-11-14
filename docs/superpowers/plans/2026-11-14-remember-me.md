# Remember Me Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add default-off login persistence with a remembered 30-day refresh session.

**Architecture:** Sign an optional `rememberMe` boolean in both JWT types. Centralize default lifetimes and cookie issuance; preserve the signed policy through refresh and password replacement while retaining legacy/setup behavior.

**Tech Stack:** Bun, SQLite, jose, Vue 3, existing Tailwind theme and i18n.

**Spec:** `docs/superpowers/specs/2026-11-14-remember-me-design.md`

## Global Constraints

- Access TTL: 900 seconds; ordinary/legacy refresh TTL: 604800 seconds; remembered refresh TTL: 2592000 seconds.
- Unchecked means no cookie `Max-Age` or `Expires`; checked means persistent cookies.
- Absent signed preference retains legacy persistent 7-day behavior; setup remains unchanged.
- No token/password browser storage, new dependency, generated-file edits, commit, or push.
- Keep Origin checks, cookie security flags, short access tokens and token-version revocation.

## Review Focus

- Null, array and non-boolean login input must fail cleanly instead of enabling persistence.
- Forged or incorrectly typed signed policy must not grant a longer session.
- A conflicting body flag during refresh/password change must not override signed policy.
- Legacy JWTs and setup must retain 7-day persistence rather than gain 30 days.
- Password replacement must invalidate old tokens while retaining the current session's policy.

---

### Task 1: Signed policy and token lifetimes

**Files:** Create `apps/control-server/src/auth/session-policy.ts`; modify/test `auth/tokens.ts`, `auth/tokens.test.ts`, `auth/auth-service.ts`, `auth/auth-service.test.ts` under `apps/control-server/src/`.

**Interfaces:** Export `ACCESS_TTL_SECONDS = 900`, `REFRESH_TTL_SECONDS = 604800`, `REMEMBERED_REFRESH_TTL_SECONDS = 2592000`. Add `rememberMe?: boolean` to `TokenClaims` and successful `AuthenticateResult`. Extend `issueAccessToken(userId: string, rememberMe?: boolean): Promise<string>` and `issueRefreshToken(userId: string, rememberMe?: boolean): Promise<string>`. Successful `refresh()` includes optional `rememberMe` and signs the same policy on both replacement tokens. Omitted policy remains omitted, preserving exact legacy authentication results.

- [ ] Add tests: both booleans round-trip; absent claim stays absent; signed non-boolean returns `missing_claims`; altered preference fails signature; jose `decodeJwt` gives `exp - iat` of 900/604800/2592000 as applicable; refresh retains true/false/undefined and revoked remembered tokens fail.
- [ ] Run `bun test apps/control-server/src/auth`; confirm new assertions fail before implementation.
- [ ] Implement signing/verification of the optional boolean and use centralized defaults. Retain `AuthOptions.refreshTtlSeconds` for ordinary/legacy issuance; true uses the 30-day constant.
- [ ] Run the auth tests; require zero failures.

### Task 2: Login and refresh cookie policy

**Files:** Modify/test `apps/control-server/src/routes/auth-routes.ts` and `auth-routes.test.ts`.

**Interfaces:** Re-export existing TTL constants from the policy module. Add `appendAuthCookies(request: Request, headers: Headers, accessToken: string, refreshToken: string, rememberMe?: boolean): void`, shared by login, setup, refresh, and password change. False omits expiration attributes; true/undefined use their respective persistent TTLs.

- [ ] Add login tests for omitted/false session cookies, true 30-day cookies and JWTs, invalid booleans/null/arrays, wrong credentials and foreign Origin. Assert HttpOnly/SameSite/Path/Secure with forwarded HTTPS.
- [ ] Add refresh tests for true/false/undefined, cookie attributes and JWT TTLs; conflicting body flags must be ignored. Pin setup's persistent 7-day cookies.
- [ ] Run `bun test apps/control-server/src/routes/auth-routes.test.ts`; confirm the new policy tests fail.
- [ ] Implement login body validation/default false; sign both tokens with it. Implement shared cookies and refresh retention. Add no-store to issuance responses.
- [ ] Run route and auth tests; require zero failures.

### Task 3: Password replacement and login form

**Files:** Modify/test `apps/control-server/src/routes/me-routes.ts`, `me-routes.test.ts`; modify `apps/web/src/views/LoginView.vue`, `apps/web/src/lib/i18n/types.ts`, `apps/web/src/lib/i18n/locales/en.ts`, `locales/vi.ts`; create `apps/web/src/views/LoginView.test.ts`.

**Interfaces:** Before password writes/revocation, authenticate the existing access cookie using `AuthService.authenticate`; require the same authorized user, then use its optional `rememberMe` for replacement JWTs and `appendAuthCookies`. BrowserGateway's public result remains unchanged. Login SFC uses `rememberMe = ref(false)`, binds the native checkbox via `v-model`, and posts `rememberMe.value`.

- [ ] Add password tests for true/false/undefined persistence, replacement JWT TTL/policy and old-token revocation. Include conflicting body/refresh-cookie policies; signed access policy wins.
- [ ] Add source-contract tests (existing SFC-test convention) for default false, checkbox v-model, accessible id/label, translated 30-day copy and JSON payload. No storage calls are added.
- [ ] Run `bun test apps/control-server/src/routes/me-routes.test.ts apps/web/src/views/LoginView.test.ts`; confirm new failures.
- [ ] Implement password policy retention and the checkbox between password and Continue. Add `auth.rememberMe` translations with exact spec copy. Use generated theme utilities only.
- [ ] Run focused tests, then `bun test`, `bun run typecheck`, `bun run lint`, and `bun run --cwd apps/web build`. Generated Vue diagnostics may be ignored only as already configured.
- [ ] Inspect diff for unintended files/secrets/generated edits. Obtain one read-only independent final review; address verified findings and rerun affected/full gates. Report actual results without committing or pushing.

## Execution

Use native execution in this session: the user requested continuation without further questions. Self-review the plan against the spec before implementation. No commit steps are authorized.
