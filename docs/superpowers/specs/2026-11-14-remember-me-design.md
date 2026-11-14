# Remember Me Design

## Intent and scope

Add an optional Remember me checkbox to the existing login form. The user chose a 30-day remembered login; leaving the checkbox unchecked creates browser-session cookies. Do not store passwords or tokens in browser storage.

## Approaches

- UI-only persistence cannot work: cookies and refresh JWT expiry are controlled by the server.
- A separate unsigned preference cookie would be mutable and could incorrectly extend a login during refresh.
- Use an optional signed `rememberMe` boolean in access and refresh JWTs. This is the implementation choice: it preserves the policy across refresh and password changes without adding database state or changing the browser gateway.

## Behavior

- Login sends `rememberMe: boolean`, default `false`. Reject a supplied non-boolean with HTTP 400.
- `false`: both cookies omit `Max-Age` and `Expires`; refresh JWT lifetime remains 604800 seconds (7 days).
- `true`: refresh JWT and refresh cookie lifetime are 2592000 seconds (30 days); access JWT and persistent access cookie remain 900 seconds (15 minutes).
- Refresh retains the signed preference and renews the corresponding lifetime (the existing rolling-refresh model). The 30-day window runs from the latest successful issuance, not an absolute initial-login deadline.
- Password changes retain the authenticated access token's signed preference before revocation and mint replacement tokens under the new token version. Do not trust a request-body flag or a different refresh cookie.
- JWTs without the preference retain the existing persistent 7-day behavior. First-time setup remains unchanged and issues this legacy policy; no setup checkbox is added.
- All cookies retain `HttpOnly`, `SameSite=Lax`, `Path=/`, and the existing Secure/proxy/override behavior. Logout and token-version revocation remain effective.
- Session-cookie removal follows browser-session behavior; browser session restoration can retain session cookies.

## UI and constraints

Place a native, keyboard-accessible checkbox and associated label below the password field and above Continue. Default unchecked; label: `Remember me for 30 days` / `Ghi nhớ đăng nhập trong 30 ngày`. Follow existing native-checkbox call-site styling with generated theme utilities. Do not modify any generated shadcn-vue file or add dependencies.

## Verification

Test signed policy validation/tampering, JWT TTLs, login cookie attributes, malformed login bodies, refresh policy retention despite conflicting client input, legacy compatibility, password-change policy retention and revocation, and the SFC checkbox/payload binding. Run `bun test`, `bun run typecheck`, `bun run lint`, and the web build. Browser verification depends on BrowserOS connectivity; report it as skipped if unavailable. No commit or push is authorized for this feature.
