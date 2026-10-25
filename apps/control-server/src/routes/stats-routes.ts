import { usageStats } from "@cc-web/control-db";
import type { ServerOptions } from "../server.ts";
import type { BrowserGateway } from "../websocket/browser/browser-gateway.ts";

/**
 * The dashboard's usage read (token in/cache/out totals, a daily series,
 * volume counts). Same authentication shape as the session list: Origin
 * first, then the cookie, and the aggregation is scoped to the authorized
 * owner inside `usageStats` — the query is the access rule.
 */
export async function handleUsageStats(
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

  return new Response(JSON.stringify(usageStats(options.db, authorized.userId)), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
