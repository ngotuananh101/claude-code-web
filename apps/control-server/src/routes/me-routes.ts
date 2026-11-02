import type { ServerOptions } from "../server.ts";
import type { BrowserGateway } from "../websocket/browser/browser-gateway.ts";
import { COOKIE_NAME, REFRESH_COOKIE_NAME, ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS } from "./auth-routes.ts";

/**
 * The signed-in account's own name for the rail's footer (§16.2). The footer
 * cannot hardcode it: the operator seeds whatever username they choose.
 *
 * Same authentication as every browser call: Origin allowlist, then the
 * session cookie. `no-store` because the answer is identity-bearing (§19.4).
 */
export async function handleMe(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin !== null && !allowedOrigins.has(origin)) {
    return new Response("forbidden", { status: 403 });
  }

  const authorized = await browserGateway.authorize({
    origin: origin ?? undefined,
    cookie: request.headers.get("cookie") ?? undefined,
  });
  if (!authorized.ok) {
    return new Response("unauthorized", { status: 401 });
  }

  const row = options.db
    .query("SELECT username, avatar FROM users WHERE id = ?")
    .get(authorized.userId) as { username: string; avatar: string | null } | null;
  if (row === null) {
    // authenticate() proved the token names a live row; treat anything else
    // as no session rather than guessing at an account to show.
    return new Response("unauthorized", { status: 401 });
  }

  return new Response(JSON.stringify({ username: row.username, avatar: row.avatar }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const USERNAME_REGEX = /^[a-zA-Z0-9_.-]{2,32}$/;
const AVATAR_DATA_URI_REGEX = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/;

function parseBase64Size(base64: string): number {
  // Base64 encodes 6 bits per character; 4 chars -> 3 bytes
  // Remove any padding and calculate raw size
  const paddedLen = base64.length;
  const padding = base64.endsWith("=") ? (base64.endsWith("==") ? 2 : 1) : 0;
  return (paddedLen - padding) * 3 / 4;
}

export async function handleUpdateMe(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin !== null && !allowedOrigins.has(origin)) {
    return new Response("forbidden", { status: 403 });
  }

  const authorized = await browserGateway.authorize({
    origin: origin ?? undefined,
    cookie: request.headers.get("cookie") ?? undefined,
  });
  if (!authorized.ok) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const record = body as Record<string, unknown>;
  const username = record["username"];
  const avatar = record["avatar"];
  const currentPassword = record["currentPassword"];
  const newPassword = record["newPassword"];

  // Validation types
  if (username !== undefined && typeof username !== "string") {
    return new Response("bad request", { status: 400 });
  }
  if (avatar !== undefined && typeof avatar !== "string" && avatar !== null) {
    return new Response("bad request", { status: 400 });
  }
  if (currentPassword !== undefined && typeof currentPassword !== "string") {
    return new Response("bad request", { status: 400 });
  }
  if (newPassword !== undefined && typeof newPassword !== "string") {
    return new Response("bad request", { status: 400 });
  }

  const verifyPassword = options.verifyPassword ?? (async () => false);
  const hashPassword = options.hashPassword;

  // Process username update if provided
  if (username !== undefined) {
    if (!USERNAME_REGEX.test(username)) {
      return new Response("invalid username format", { status: 400 });
    }

    // Check uniqueness
    const existing = options.db
      .query("SELECT id FROM users WHERE username = ? AND id != ?")
      .get(username, authorized.userId) as { id: string } | null;

    if (existing !== null) {
      return new Response(JSON.stringify({ ok: false, error: "Username already taken" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }

    options.db.query("UPDATE users SET username = ? WHERE id = ?").run(username, authorized.userId);
  }

  // Process avatar update if provided
  if (avatar !== undefined) {
    if (avatar === null || avatar === "") {
      // Clear avatar
      options.db.query("UPDATE users SET avatar = NULL WHERE id = ?").run(authorized.userId);
    } else {
      const match = avatar.match(AVATAR_DATA_URI_REGEX);
      if (!match) {
        return new Response("invalid avatar format", { status: 400 });
      }

      const base64Data = match[2];
      const size = parseBase64Size(base64Data);
      if (size > 256 * 1024) {
        return new Response("avatar too large", { status: 400 });
      }

      options.db.query("UPDATE users SET avatar = ? WHERE id = ?").run(avatar, authorized.userId);
    }
  }

  // Process password update if newPassword is provided
  if (newPassword !== undefined) {
    if (currentPassword === undefined || currentPassword === "") {
      return new Response(JSON.stringify({ ok: false, error: "Mật khẩu hiện tại không đúng" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const user = options.db
      .query("SELECT password_hash FROM users WHERE id = ?")
      .get(authorized.userId) as { password_hash: string } | null;

    if (!user) {
      return new Response("unauthorized", { status: 401 });
    }

    const passwordValid = await verifyPassword(currentPassword, user.password_hash);
    if (!passwordValid) {
      return new Response(JSON.stringify({ ok: false, error: "Mật khẩu hiện tại không đúng" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (newPassword.length < 8) {
      return new Response(JSON.stringify({ ok: false, error: "Mật khẩu mới phải có ít nhất 8 ký tự" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!hashPassword) {
      return new Response("password update unavailable", { status: 503 });
    }

    const newHash = await hashPassword(newPassword);
    options.db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(newHash, authorized.userId);

    // Bump token_version and re-mint tokens
    options.auth.revokeAllSessions(authorized.userId);
    const newAccessToken = await options.auth.issueAccessToken(authorized.userId);
    const newRefreshToken = await options.auth.issueRefreshToken(authorized.userId);

    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    const headers = new Headers();
    headers.set("Content-Type", "application/json");

    headers.append(
      "Set-Cookie",
      `${COOKIE_NAME}=${newAccessToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ACCESS_TTL_SECONDS}${secure}`,
    );
    headers.append(
      "Set-Cookie",
      `${REFRESH_COOKIE_NAME}=${newRefreshToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${REFRESH_TTL_SECONDS}${secure}`,
    );

    const row = options.db
      .query("SELECT username, avatar FROM users WHERE id = ?")
      .get(authorized.userId) as { username: string; avatar: string | null };

    return new Response(JSON.stringify({ ok: true, username: row.username, avatar: row.avatar }), {
      status: 200,
      headers,
    });
  }

  const row = options.db
    .query("SELECT username, avatar FROM users WHERE id = ?")
    .get(authorized.userId) as { username: string; avatar: string | null };

  return new Response(JSON.stringify({ ok: true, username: row.username, avatar: row.avatar }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
