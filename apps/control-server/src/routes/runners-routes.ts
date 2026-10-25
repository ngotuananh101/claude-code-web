import { createRunnerToken, listRunners } from "@cc-web/control-db";
import type { ServerOptions } from "../server.ts";
import type { BrowserGateway } from "../websocket/browser/browser-gateway.ts";

/**
 * The owner's runner registry over HTTP (§6.1, connector model): mint a
 * connector token, list what exists.
 *
 * Authenticated like any other browser call: Origin first, then the session
 * cookie. A token minted for a hostile page is a token the attacker can
 * redeem, so this check is not optional just because the response contains
 * no user data.
 */
export async function handleCreateRunner(
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

  const minted = createRunnerToken(options.db, { ownerId: authorized.userId });

  // The token is in this response and nowhere else. `no-store` keeps it out of
  // any intermediate cache; the database only ever holds its hash.
  return new Response(JSON.stringify({ runnerId: minted.runnerId, token: minted.token }), {
    status: 201,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * The owner's runner list.
 *
 * `listRunners` answers with ids and lifecycle timestamps only — no secret
 * material exists to leak, because no plaintext token was ever stored.
 * `no-store` because the answer is identity-bearing (§19.4).
 */
export async function handleListRunners(
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

  return new Response(JSON.stringify({ runners: listRunners(options.db) }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
