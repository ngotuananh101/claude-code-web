import {
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  REMEMBERED_REFRESH_TTL_SECONDS,
} from "../auth/session-policy.ts";
import type { ServerOptions } from "../server.ts";
import type { BrowserGateway } from "../websocket/browser/browser-gateway.ts";

/**
 * The owner's session endpoints (ADR-0001): login mints the access-token
 * cookie, logout revokes every outstanding token for the account.
 *
 * Origin first on both: a correct password from a hostile page must not mint
 * a session, and the check must not depend on the password being wrong.
 */

export { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS, REMEMBERED_REFRESH_TTL_SECONDS };
export const COOKIE_NAME = "cc_session";
export const REFRESH_COOKIE_NAME = "cc_refresh";

export function readCookie(cookie: string | undefined, name: string): string | undefined {
  if (cookie === undefined) return undefined;
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
  }
  return undefined;
}

/**
 * Whether session cookies should carry the Secure flag for this request.
 *
 * The old rule only looked at the request URL's own protocol. Behind a
 * TLS-terminating proxy (Caddy in production) the control server sees
 * plain http on loopback even though the browser is on https, so Secure
 * was silently dropped in exactly the deployment that needs it.
 *
 * Trusting X-Forwarded-Proto for this one flag is safe in that direction:
 * a client that spoofs "https" only gets a stricter Secure cookie, never
 * a weaker one. An explicit CC_WEB_SECURE_COOKIES=true/false overrides
 * both, so local plain-http dev can keep working and production can
 * force Secure regardless of proxy headers.
 */
export function cookieSecureFlag(request: Request): string {
  const override = process.env["CC_WEB_SECURE_COOKIES"];
  if (override === "true") return "; Secure";
  if (override === "false") return "";
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded === "https") return "; Secure";
  return new URL(request.url).protocol === "https:" ? "; Secure" : "";
}

/**
 * Writes both session cookies with one shared policy:
 * - `rememberMe === false`: browser-session cookies (omit `Max-Age`/`Expires`).
 * - `rememberMe === true`: persistent cookies with a 30-day refresh lifetime.
 * - `rememberMe === undefined`: legacy/setup persistent cookies with a 7-day refresh lifetime.
 */
export function appendAuthCookies(
  request: Request,
  headers: Headers,
  accessToken: string,
  refreshToken: string,
  rememberMe?: boolean,
): void {
  const secure = cookieSecureFlag(request);
  const accessMaxAge = rememberMe === false ? "" : `; Max-Age=${ACCESS_TTL_SECONDS}`;
  const refreshMaxAge =
    rememberMe === false
      ? ""
      : `; Max-Age=${rememberMe === true ? REMEMBERED_REFRESH_TTL_SECONDS : REFRESH_TTL_SECONDS}`;

  headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${accessToken}; HttpOnly; SameSite=Lax; Path=/${accessMaxAge}${secure}`,
  );
  headers.append(
    "Set-Cookie",
    `${REFRESH_COOKIE_NAME}=${refreshToken}; HttpOnly; SameSite=Lax; Path=/${refreshMaxAge}${secure}`,
  );
}

/**
 * First-time setup (§19.1): whether the owner account still needs seeding.
 *
 * Read-only and unauthenticated by design: the web front door calls this before
 * the operator has any credential, and the answer (`{ setupRequired: true }`)
 * is not identity-bearing. `no-store` so a cached "true" never hides a seed that
 * happened to land a moment later.
 */
export function handleSetupStatus(
  request: Request,
  options: ServerOptions,
  allowedOrigins?: ReadonlySet<string>,
): Response {
  const origin = request.headers.get("origin") ?? undefined;
  if (origin !== undefined && allowedOrigins !== undefined && !allowedOrigins.has(origin)) {
    return new Response("forbidden", { status: 403 });
  }

  const count = options.db.query("SELECT COUNT(*) AS count FROM users").get() as { count: number };

  return new Response(JSON.stringify({ setupRequired: count.count === 0 }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * First-time setup (§19.1): create the single owner account.
 *
 * Locked to the moment when `users` is empty — once seeded, this route is the
 * only write path that can mint a session without a password check, so it must
 * be unreachable afterwards. The insert and the cookie issuance run in one
 * transaction: a half-applied setup (row written, token not issued) would
 * leave the system unable to log in.
 */
export async function handleSetup(
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

  const trimmedUsername = username.trim();
  if (trimmedUsername === "" || password.trim() === "") {
    return new Response("bad request", { status: 400 });
  }

  // Re-check under no user as the gate, inside the transaction that inserts.
  // SQLite's default transaction handles this: the count read and the insert
  // commit together, so two concurrent setup requests cannot both succeed.
  const id = crypto.randomUUID();
  const hashPassword = options.hashPassword;
  if (!hashPassword) {
    return new Response("setup unavailable", { status: 503 });
  }
  const passwordHash = await hashPassword(password);

  const row = options.db.query("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  if (row.count > 0) {
    return new Response("forbidden", { status: 403 });
  }

  try {
    options.db.exec("BEGIN IMMEDIATE");
    // Re-check inside the transaction: another request may have committed
    // between the pre-check and the `BEGIN`.
    const locked = options.db.query("SELECT COUNT(*) AS count FROM users").get() as {
      count: number;
    };
    if (locked.count > 0) {
      options.db.exec("ROLLBACK");
      return new Response("forbidden", { status: 403 });
    }

    options.db
      .query(
        "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, trimmedUsername, passwordHash, 1, Date.now());
    options.db.exec("COMMIT");
  } catch (error) {
    try {
      options.db.exec("ROLLBACK");
    } catch {
      // Already rolled back.
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNIQUE")) {
      return new Response("forbidden", { status: 403 });
    }
    throw error;
  }

  const token = await options.auth.issueAccessToken(id);
  const refreshToken = await options.auth.issueRefreshToken(id);

  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  appendAuthCookies(request, headers, token, refreshToken);

  return new Response(JSON.stringify({ ok: true, user: { id, username: trimmedUsername } }), {
    status: 201,
    headers,
  });
}

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

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return new Response("bad request", { status: 400 });
  }

  const record = body as Record<string, unknown>;
  const username = record["username"];
  const password = record["password"];
  const rememberMeRaw = record["rememberMe"];
  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    (rememberMeRaw !== undefined && typeof rememberMeRaw !== "boolean")
  ) {
    return new Response("bad request", { status: 400 });
  }
  const rememberMe = rememberMeRaw === true;

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

  const token = await options.auth.issueAccessToken(row.id, rememberMe);
  const refreshToken = await options.auth.issueRefreshToken(row.id, rememberMe);

  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  appendAuthCookies(request, headers, token, refreshToken, rememberMe);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers,
  });
}

/**
 * Token refresh (§19.1, ADR-0001). Reads the refresh cookie, validates and
 * rotates both the access token and the refresh token.
 */
export async function handleRefresh(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
): Promise<Response> {
  const origin = request.headers.get("origin") ?? undefined;
  if (origin !== undefined && !allowedOrigins.has(origin)) {
    return new Response("forbidden", { status: 403 });
  }

  const rawCookie = request.headers.get("cookie") ?? undefined;
  const refreshToken = readCookie(rawCookie, REFRESH_COOKIE_NAME);
  if (!refreshToken) {
    return new Response("unauthorized", { status: 401 });
  }

  const result = await options.auth.refresh(refreshToken);
  if (!result.ok) {
    return new Response("unauthorized", { status: 401 });
  }

  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  appendAuthCookies(request, headers, result.accessToken, result.refreshToken, result.rememberMe);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers,
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

  const secure = cookieSecureFlag(request);
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
  );
  headers.append(
    "Set-Cookie",
    `${REFRESH_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
  );

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers,
  });
}
