# ADR-0001 — Owner authentication with JWT

- Status: accepted
- Date: 2026-10-23
- Supersedes: nothing. Refines ARCHITECTURE.md §19.1.

## Context

§19.1 requires an owner login for a single trusted operator, public signup
disabled, cookie flags `HttpOnly`/`Secure`/SameSite, CSRF on mutations, and an
Origin allowlist before the browser WebSocket upgrade. It also requires that
revoking a login tears down that user's socket subscriptions.

A JWT is stateless: the signature proves issuance, not that the session is still
wanted. So a plain JWT cannot satisfy the revocation requirement on its own.

## Decision

Use JWT **access tokens** as the session credential, with three supporting
mechanisms:

1. **Transport**: access token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie.
   The browser WebSocket upgrade authenticates from the same cookie, guarded by
   the Origin allowlist — the cookie is not the only control.
2. **Lifetime**: short access TTL, with a refresh token that is revocable
   server-side. Refresh rotation on use.
3. **Revocation**: a per-user `tokenVersion` (and per-session `auth_sessions`
   row) recorded in the control DB. Every token carries the version it was
   issued under; a mismatch rejects the token. Bumping the version on logout,
   revoke or password change invalidates all outstanding access tokens and closes
   matching socket subscriptions.

Password hashing and token signing use a maintained library — not hand-written
crypto (§19.1). Algorithm is fixed and asymmetric-or-HS256-with-managed-secret;
`alg: none` and algorithm confusion are rejected at verification.

Runner authentication stays **separate** (§19.2): a scoped per-Runner credential,
never a web cookie or an owner JWT.

## Consequences

- Revocation costs one DB read per authenticated request or socket upgrade.
  Acceptable at MVP scale; cache the version per connection, not per message.
- `tokenVersion` is a hard dependency of the auth layer. Adding it later would
  mean invalidating every live session.
- The control DB is on the auth critical path: if it is unavailable, no request
  authenticates. Fail closed.
- Multi-instance deployments (§21.2) need the version check to read shared state;
  a local cache would break revocation across gateways.
