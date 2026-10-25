import { workspacesForOwner } from "@cc-web/control-db";
import type { ServerOptions } from "../server.ts";
import type { BrowserGateway } from "../websocket/browser/browser-gateway.ts";

/**
 * The owner's workspace list over HTTP (§16.1, §17.1).
 *
 * Every row here is a workspace a connected runner declared (§15.1) — the
 * composer's project select reads this, which is what makes "chọn workspace"
 * workspace-first instead of topology-first. Auth mirrors `runners-routes.ts`:
 * Origin allowlist, then the session cookie, `no-store` because the answer is
 * identity-bearing (§19.4).
 */
export async function handleListWorkspaces(
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

  return new Response(
    JSON.stringify({ workspaces: workspacesForOwner(options.db, authorized.userId) }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    },
  );
}
