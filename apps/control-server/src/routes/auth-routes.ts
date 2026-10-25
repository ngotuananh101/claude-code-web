import type { ServerOptions } from "../server.ts";
import type { BrowserGateway } from "../websocket/browser/browser-gateway.ts";

/**
 * The owner's session endpoints (ADR-0001): login mints the access-token
 * cookie, logout revokes every outstanding token for the account.
 *
 * Origin first on both: a correct password from a hostile page must not mint
 * a session, and the check must not depend on the password being wrong.
 */

export const COOKIE_NAME = "cc_session";
const ACCESS_TTL_SECONDS = 15 * 60;

export async function handleLogin(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
): Promise<Response> {
  const origin = request.headers.get("origin") ?? undefined;
  if (!origin || !allowedOrigins.has(origin)) {
    return new Response("forbidden", { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const record = body as Record<string, unknown>;
  const username = record["username"];
  const password = record["password"];
  if (typeof username !== "string" || typeof password !== "string") {
    return new Response("bad request", { status: 400 });
  }

  const row = options.db
    .query("SELECT id, password_hash FROM users WHERE username = ?")
    .get(username) as { id: string; password_hash: string } | null;

  // One response for "no such user" and "wrong password": distinguishing them
  // turns the endpoint into a username oracle.
  const verify = options.verifyPassword ?? (async () => false);
  const ok = row ? await verify(password, row.password_hash) : false;
  if (!row || !ok) {
    return new Response("unauthorized", { status: 401 });
  }

  const token = await options.auth.issueAccessToken(row.id);

  // Secure only when the request is actually https: on a plain-http origin
  // (local dev, self-hosted LAN) a Secure cookie is dropped by the browser,
  // which would turn every login into a silent no-op. The flag still does
  // its real work wherever TLS terminates at this server.
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // ADR-0001: HttpOnly so script cannot read it, SameSite=Lax so a
      // cross-site form post does not carry it.
      "Set-Cookie": `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ACCESS_TTL_SECONDS}${secure}`,
    },
  });
}

/**
 * Sign-out (§12.5 + ADR-0001). Bumping the token version kills every
 * outstanding access token with this one request; `revoke` closes the live
 * sockets the login opened so a signed-out tab stops streaming immediately.
 */
export async function handleLogout(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
): Promise<Response> {
  const origin = request.headers.get("origin") ?? undefined;
  if (origin !== undefined && !allowedOrigins.has(origin)) {
    return new Response("forbidden", { status: 403 });
  }

  const authorized = await browserGateway.authorize({
    origin,
    cookie: request.headers.get("cookie") ?? undefined,
  });
  if (!authorized.ok) {
    return new Response("unauthorized", { status: 401 });
  }

  options.auth.revokeAllSessions(authorized.userId);
  browserGateway.revoke(authorized.userId);

  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
    },
  });
}
