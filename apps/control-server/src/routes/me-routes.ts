import type { ServerOptions } from "../server.ts";
import type { BrowserGateway } from "../websocket/browser/browser-gateway.ts";

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
    .query("SELECT username FROM users WHERE id = ?")
    .get(authorized.userId) as { username: string } | null;
  if (row === null) {
    // authenticate() proved the token names a live row; treat anything else
    // as no session rather than guessing at an account to show.
    return new Response("unauthorized", { status: 401 });
  }

  return new Response(JSON.stringify({ username: row.username }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
