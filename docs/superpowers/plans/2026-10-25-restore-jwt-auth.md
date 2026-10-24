# Plan — Restore the self-written JWT auth flow, drop better-auth

- Date: 2026-10-25
- Owner request: "Đổi lại luồng JWT tự viết nhé. Bỏ hết better-auth."
- Supersedes: the auth half of `2026-10-24-better-auth-and-connector-runner.md`
  (its connector half — runner tokens, runners console, compiled runner — stays).

## Intent

The owner wants the hand-written owner-auth flow (ADR-0001) back and every
trace of better-auth gone: dependency, `/api/auth/*` mount, session tables,
env vars. What must survive from the better-auth era: the connector-token
model (§6.1/ADR-015 runner half), the runners console, the redesigned login
UI (Tailwind utilities), sonner notifications, and the sign-out-closes-sockets
behavior (reimplemented on JWT).

## Decisions

- **Restore, don't rewrite.** The old stack at `f93216e^` is the last reviewed
  JWT implementation: `auth/tokens.ts` (jose, HS256 pinned), `auth/password.ts`
  (Bun.password argon2id), `auth/auth-service.ts` (per-check DB comparison
  against `users.token_version` — stateful revocation, §21.2 fail-closed).
  ADR-0001's rule "no hand-written crypto" stands; jose stays.
- **Forward-merge, not `git revert`.** Later commits (T4 sockets, T5 runners
  console) built on the better-auth resolver; the current tree keeps them and
  swaps the resolver seam back to `AuthService`.
- **Cookie** `cc_session`, HttpOnly, SameSite=Lax, Secure on https — as before.
- **Sign-out** = `POST /auth/logout`: bump `token_version` (revokes every
  outstanding token), clear the cookie, `browserGateway.revoke(userId)` so
  live sockets close (4001) — the T4 behavior on the JWT core.
- **Login failure** stays one message (no username oracle): the web toasts
  "Sai tên đăng nhập hoặc mật khẩu." mirroring the BE's single 401.
- **DB**: migrate re-creates `users`, drops the better-auth tables
  (`user/session/account/verification`); `runner_credentials` untouched.
  Demo DB is recreated and reseeded (`owner` / `demo-password-123`).

## Tasks

| # | Task | Verification |
|---|------|--------------|
| T1 | Restore `auth/{tokens,password,auth-service}.ts` + tests from `f93216e^`; delete `better-auth.{ts,test.ts}`; swap deps (remove better-auth, add jose) | `bun test apps/control-server/src/auth` green |
| T2 | `control-db`: users table back, drop better-auth tables in migrate | `bun test packages/control-db` green |
| T3 | `config`: `CC_WEB_JWT_SECRET` back, `BETTER_AUTH_*` gone | config tests green |
| T4 | `server.ts`: `/auth/login` + `/auth/logout` routes, session resolve via AuthService, revoke on logout; drop AUTH_MOUNT; `index.ts` wiring; server tests updated | `bun test apps/control-server` green |
| T5 | Web: `fetch("/auth/login")` in LoginView (keep Tailwind + sonner), sign-out → `/auth/logout`, delete `auth-client.ts` + dep, vite `/auth` proxy | typecheck, build, browser pass |
| T6 | `seed-user.ts` / `seed-demo.ts` back to the users table; integration probes' login helper | `bun run test:integration` green |
| T7 | Docs: ADR-0001 accepted (reinstated), ADR-015 superseded (auth half), ARCHITECTURE §6/§17/§18/§19/§20, CLAUDE.md, README | review |
| T8 | Full gates, fresh demo DB, browser pass (login wrong/right, sign-out closes socket, runners mint), push | all green, pushed |
