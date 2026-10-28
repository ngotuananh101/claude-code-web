import { randomUUID } from "node:crypto";
import { listRunners, registerWorkspace } from "@cc-web/control-db";
import { BROWSE_CAPABILITY } from "@cc-web/protocol";
import type { Dispatcher } from "../dispatch/dispatcher.ts";
import type { PendingRpcRequests } from "../rpc/pending-requests.ts";
import type { ServerOptions } from "../server.ts";
import type { BrowserGateway } from "../websocket/browser/browser-gateway.ts";
import type { RunnerGateway } from "../websocket/runner/runner-gateway.ts";
import { jsonError } from "./api-error.ts";
import { submitRpc } from "./rpc-command.ts";

/**
 * The directory browse and workspace-registration surface over HTTP (§23,
 * Task 8).
 *
 * Two routes:
 *
 * - `GET /api/runners/:runnerId/browse?path=...` forwards a
 *   `workspace.fs.browse` command to a ready runner and answers with its
 *   `rpc.result`, reusing `submitRpc` for the readiness check, capability gate,
 *   enqueue/drain/waiter/refusal/success sequence.
 *
 * - `POST /api/runners/:runnerId/workspaces` registers a custom path in the
 *   control plane's `workspaces` table so the owner can address it through a
 *   stable composite id (`runnerId/workspaceId`).
 *
 * Auth mirrors every other browser route: Origin allowlist, then the session
 * cookie. `no-store` because the answers are identity-bearing (§19.4).
 */

/**
 * `GET /api/runners/:runnerId/browse?path=...`
 *
 * The runner is the authority on its own filesystem; the request carries only a
 * relative path and the runner resolves it against its workspace root (Task 3).
 * The server's only job is to forward the bounded `workspace.fs.browse` command
 * to a ready runner that advertises `BROWSE_CAPABILITY`.
 */
export async function handleBrowse(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
  runnerGateway: RunnerGateway,
  pending: PendingRpcRequests,
  dispatcher: Dispatcher | undefined,
  runnerId: string,
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

  // The runner is identified by its id, not a composite id — the workspace is
  // resolved server-side from the requested path. But the owner must still hold
  // the runner.
  const owned = listRunners(options.db, authorized.userId).some(
    (runner) => runner.runnerId === runnerId && runner.revokedAt === null,
  );
  if (!owned) {
    return jsonError("RUNNER_NOT_FOUND", "runner not found", 404);
  }

  const url = new URL(request.url);
  const path = url.searchParams.get("path") ?? "";

  return submitRpc(options, runnerGateway, pending, dispatcher, {
    runnerId,
    workspaceId: "",
    kind: "workspace.fs.browse",
    payload: { path },
    capability: BROWSE_CAPABILITY,
  });
}

/**
 * `POST /api/runners/:runnerId/workspaces`
 *
 * Register a custom path the owner has chosen through the directory browser.
 * The control plane mints a `workspaceId` (a UUID) so the folder is addressable
 * by a stable id before the runner reconciles it back; the same id becomes part
 * of the composite id used by `/api/workspaces/:workspaceId/sessions`.
 *
 * The runner is the registration authority for declared workspaces (§15.1), and
 * this route does not override that — it writes a single row that
 * `workspacesForOwner` reads, so the composite-id ownership check in the
 * session routes sees the custom workspace immediately.
 */
export async function handleRegisterWorkspace(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
  runnerId: string,
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

  const owned = listRunners(options.db, authorized.userId).some(
    (runner) => runner.runnerId === runnerId && runner.revokedAt === null,
  );
  if (!owned) {
    return jsonError("RUNNER_NOT_FOUND", "runner not found", 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("MALFORMED_BODY", "invalid JSON body", 400);
  }

  if (typeof body !== "object" || body === null) {
    return jsonError("MALFORMED_BODY", "request body must be a JSON object", 400);
  }

  const record = body as Record<string, unknown>;
  const path = record["path"];
  if (typeof path !== "string" || path.trim() === "") {
    return jsonError("MALFORMED_BODY", "path must be a non-empty string", 400);
  }

  const rawWorkspaceId = record["workspaceId"];
  const workspaceId =
    typeof rawWorkspaceId === "string" && rawWorkspaceId.trim() !== ""
      ? rawWorkspaceId
      : randomUUID();

  registerWorkspace(options.db, runnerId, workspaceId, path);

  return new Response(JSON.stringify({ workspaceId, path, runnerId }), {
    status: 201,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
