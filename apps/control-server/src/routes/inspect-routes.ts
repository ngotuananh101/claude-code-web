import { workspacesForOwner } from "@cc-web/control-db";
import { INSPECT_CAPABILITY, type RpcResultFrame } from "@cc-web/protocol";
import type { Dispatcher } from "../dispatch/dispatcher.ts";
import type { PendingRpcRequests } from "../rpc/pending-requests.ts";
import type { ServerOptions } from "../server.ts";
import type { BrowserGateway } from "../websocket/browser/browser-gateway.ts";
import type { RunnerGateway } from "../websocket/runner/runner-gateway.ts";

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

export type InspectOp = "file.list" | "file.read" | "git.changes" | "git.diff" | "diagnostics";

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
 * §17.3's `ApiError`, exactly: the code lives under `error` so the web service
 * (T11) parses one shape for every domain failure, and `requestId` is what an
 * operator quotes in a bug report. `retryable` follows the status: a 5xx may
 * work on a retry, a refusal will not.
 */
function jsonError(code: string, message: string, status: number): Response {
  return new Response(
    JSON.stringify({
      error: { code, message, retryable: status >= 500, details: undefined },
      requestId: crypto.randomUUID(),
    }),
    {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    },
  );
}

/** Map a runner refusal code to its HTTP status (§10). Anything else is a 502. */
function statusForCode(code: string): number {
  switch (code) {
    case "PATH_OUTSIDE_WORKSPACE":
      return 400;
    case "CREDENTIAL_FILE_REFUSED":
      return 403;
    case "FILE_NOT_FOUND":
    case "WORKSPACE_NOT_FOUND":
      return 404;
    default:
      return 502;
  }
}

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

  // Fast path before enqueue: the common offline case answers immediately
  // instead of through the 10 s waiter.
  if (runnerGateway.stateOf(parsed.runnerId) !== "ready") {
    return jsonError("RUNNER_UNAVAILABLE", "runner unavailable", 503);
  }
  if (!runnerGateway.capabilitiesOf(parsed.runnerId).includes(INSPECT_CAPABILITY)) {
    return jsonError("RUNNER_UNAVAILABLE", "runner does not support inspection", 503);
  }

  const outbox = options.outbox;
  if (outbox === undefined || dispatcher === undefined) {
    return jsonError("RUNNER_UNAVAILABLE", "runner unavailable", 503);
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
            : { op: "diagnostics" };

  const commandId = crypto.randomUUID();
  const now = new Date();
  const waiter = pending.register(commandId);

  try {
    await outbox.enqueue({
      commandId,
      runnerId: parsed.runnerId,
      kind,
      payload,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 15_000).toISOString(),
      workspaceId: parsed.workspaceId,
    });
  } catch {
    pending.reject(commandId, "RUNNER_UNAVAILABLE");
    return jsonError("RUNNER_UNAVAILABLE", "runner unavailable", 503);
  }

  dispatcher.drain(parsed.runnerId);

  let frame: RpcResultFrame;
  try {
    frame = await waiter;
  } catch {
    // Ruling 16: the waiter and the row retire on the same 10 s clock, with no
    // dependency on a future drain.
    try {
      outbox.markRejected(commandId, "expired");
    } catch {
      // The row is already terminal; the 503 below is still the answer.
    }
    return jsonError("RUNNER_UNAVAILABLE", "runner did not answer in time", 503);
  }

  if (!frame.ok) {
    const code = frame.error?.code ?? "UNKNOWN";
    const message = frame.error?.message ?? "inspection failed";
    // The runner's answer is also its proof the command was delivered, so the
    // row retires here either way (Ruling 2). A refusal records its code; a
    // success is only "answered", because a read starts no attempt.
    try {
      outbox.markRejected(commandId, code);
    } catch {
      // Already terminal (the timeout path won the race); nothing to record.
    }
    const status = statusForCode(code);
    return jsonError(code, message, status);
  }

  try {
    outbox.markAnswered(commandId);
  } catch {
    // Already terminal; the caller still gets its answer.
  }

  return new Response(JSON.stringify(frame.result), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
