import { workspacesForOwner } from "@cc-web/control-db";
import { INSPECT_CAPABILITY } from "@cc-web/protocol";
import type { Dispatcher } from "../dispatch/dispatcher.ts";
import type { PendingRpcRequests } from "../rpc/pending-requests.ts";
import type { ServerOptions } from "../server.ts";
import type { BrowserGateway } from "../websocket/browser/browser-gateway.ts";
import type { RunnerGateway } from "../websocket/runner/runner-gateway.ts";
import { jsonError } from "./api-error.ts";
import { submitRpc } from "./rpc-command.ts";

/**
 * The read-only inspection surface over HTTP (§23 §10).
 *
 * Five routes share one contract: the owner names a workspace through its
 * composite id, the server forwards a bounded `workspace.inspect` /
 * `config.inspect` command to the ready runner, and the runner's `rpc.result`
 * answers the waiting HTTP request.
 *
 * Auth failures stay plain text (401/403), matching every existing route.
 * Domain failures are JSON, and the answer is never cached.
 */

export type InspectOp =
  | "file.list"
  | "file.read"
  | "git.changes"
  | "git.diff"
  | "diagnostics"
  | "snapshot.status";

/**
 * Split a composite `<runnerId>/<workspaceId>` after URL-decoding it.
 *
 * The whole id is decoded first, then split on the first `/` — this is what
 * lets `encodeURIComponent("runner-a/default")` round-trip through a single
 * path segment. Both halves must be non-empty, and a workspace id carrying
 * its own `/` is refused: `workspaces` is keyed `(runner_id, workspace_id)`,
 * so a bare slash is ambiguous by construction.
 */
export function parseCompositeId(
  id: string,
): { runnerId: string; workspaceId: string } | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    return undefined;
  }
  const slash = decoded.indexOf("/");
  if (slash < 0) return undefined;
  const runnerId = decoded.slice(0, slash);
  const workspaceId = decoded.slice(slash + 1);
  if (runnerId === "" || workspaceId === "") return undefined;
  if (workspaceId.includes("/")) return undefined;
  return { runnerId, workspaceId };
}

/**
 * `jsonError`, `statusForCode` and `RETRYABLE_CODES` live in `api-error.ts`
 * (shared with the mutation surface, §7.10). This module re-exports nothing —
 * handlers import them where they are defined.
 */

export async function handleInspect(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
  runnerGateway: RunnerGateway,
  pending: PendingRpcRequests,
  dispatcher: Dispatcher | undefined,
  compositeId: string,
  op: InspectOp,
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

  const parsed = parseCompositeId(compositeId);
  if (parsed === undefined) {
    return jsonError("WORKSPACE_AMBIGUOUS", "malformed workspace id", 400);
  }

  const owned = workspacesForOwner(options.db, authorized.userId).some(
    (workspace) =>
      workspace.runnerId === parsed.runnerId && workspace.workspaceId === parsed.workspaceId,
  );
  if (!owned) {
    return jsonError("WORKSPACE_NOT_FOUND", "workspace not found", 404);
  }

  const url = new URL(request.url);
  const path = url.searchParams.get("path") ?? "";

  const kind = op === "diagnostics" ? "config.inspect" : "workspace.inspect";
  const payload =
    op === "file.list"
      ? { op: "file.list", path }
      : op === "file.read"
        ? { op: "file.read", path }
        : op === "git.changes"
          ? { op: "git.changes" }
          : op === "git.diff"
            ? { op: "git.diff", path }
            : op === "snapshot.status"
              ? { op: "snapshot.status" }
              : { op: "diagnostics" };

  // From the readiness check through the 200 response, verbatim — shared with the
  // mutation surface via `submitRpc` (§7.10).
  return submitRpc(options, runnerGateway, pending, dispatcher, {
    runnerId: parsed.runnerId,
    workspaceId: parsed.workspaceId,
    kind,
    payload,
    capability: INSPECT_CAPABILITY,
  });
}
