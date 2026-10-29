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

/**
 * First-time setup (§19.1): whether the owner account still needs seeding.
 *
 * Read-only and unauthenticated by design: the web front door calls this before
 * the operator has any credential, and the answer (`{ setupRequired: true }`)
 * is not identity-bearing. `no-store` so a cached "true" never hides a seed that
 * happened to land a moment later.
 */
export function handleSetupStatus(_request: Request, options: ServerOptions): Response {
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
  const trimmedPassword = password.trim();
  if (trimmedUsername === "" || trimmedPassword === "") {
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
  const passwordHash = await hashPassword(trimmedPassword);

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
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";

  return new Response(JSON.stringify({ ok: true, user: { id, username: trimmedUsername } }), {
    status: 201,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Set-Cookie": `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ACCESS_TTL_SECONDS}${secure}`,
    },
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
