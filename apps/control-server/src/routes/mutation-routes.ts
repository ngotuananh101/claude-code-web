/**
 * The bounded workspace mutation surface over HTTP (§7.10).
 *
 * Four routes share the inspection spine: origin allowlist → cookie auth
 * (plain-text 401/403) → `parseCompositeId` → `workspacesForOwner` →
 * `stateOf === "ready"` → capability gate → enqueue/drain/waiter/refusal.
 * The write routes gate on `WRITE_CAPABILITY`, parse a ~2 MiB JSON body first,
 * and build their payload from manual `typeof` checks before delegating to
 * `submitRpc`.
 */
import { workspacesForOwner } from "@cc-web/control-db";
import { WRITE_CAPABILITY } from "@cc-web/protocol";
import type { Dispatcher } from "../dispatch/dispatcher.ts";
import type { PendingRpcRequests } from "../rpc/pending-requests.ts";
import type { ServerOptions } from "../server.ts";
import type { BrowserGateway } from "../websocket/browser/browser-gateway.ts";
import type { RunnerGateway } from "../websocket/runner/runner-gateway.ts";
import { jsonError, statusForCode } from "./api-error.ts";
import { parseCompositeId } from "./inspect-routes.ts";
import { submitRpc } from "./rpc-command.ts";

/** Largest mutation body the edge will accept — the runner keeps files to 1 MiB (§6.2 call 7). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** The shared parameter list every mutation handler takes. */
export type MutationHandlerParams = {
  options: ServerOptions;
  allowedOrigins: ReadonlySet<string>;
  browserGateway: BrowserGateway;
  runnerGateway: RunnerGateway;
  pending: PendingRpcRequests;
  dispatcher: Dispatcher | undefined;
  compositeId: string;
};

/** The result of the common prefix: origin → auth → parse → ownership. */
type OwnershipResult =
  | { ok: true; runnerId: string; workspaceId: string }
  | { ok: false; response: Response };

/**
 * Run the part of a mutation handler that every route shares: the origin
 * allowlist, the cookie auth, the composite id parse, and the ownership check.
 * Returns the resolved `{ runnerId, workspaceId }` or a terminal `Response` the
 * caller returns directly.
 */
async function resolveOwnership(
  request: Request,
  { options, allowedOrigins, browserGateway, compositeId }: MutationHandlerParams,
): Promise<OwnershipResult> {
  const origin = request.headers.get("origin");
  if (origin !== null && !allowedOrigins.has(origin)) {
    return { ok: false, response: new Response("forbidden", { status: 403 }) };
  }

  const authorized = await browserGateway.authorize({
    origin: origin ?? undefined,
    cookie: request.headers.get("cookie") ?? undefined,
  });
  if (!authorized.ok) {
    return { ok: false, response: new Response("unauthorized", { status: 401 }) };
  }

  const parsed = parseCompositeId(compositeId);
  if (parsed === undefined) {
    return { ok: false, response: jsonError("WORKSPACE_AMBIGUOUS", "malformed workspace id", 400) };
  }

  const owned = workspacesForOwner(options.db, authorized.userId).some(
    (workspace) =>
      workspace.runnerId === parsed.runnerId && workspace.workspaceId === parsed.workspaceId,
  );
  if (!owned) {
    return { ok: false, response: jsonError("WORKSPACE_NOT_FOUND", "workspace not found", 404) };
  }

  return { ok: true, runnerId: parsed.runnerId, workspaceId: parsed.workspaceId };
}

/**
 * Parse a mutation JSON body: ~2 MiB cap (413), well-formed JSON object (400),
 * then hand the record to the per-route `validate` callback. Returns the
 * validated payload or a terminal `Response`.
 */
async function parseMutationBody(
  request: Request,
  validate: (record: Record<string, unknown>) => unknown,
): Promise<unknown | Response> {
  const text = await request.text();

  // §7.10: reject oversize bodies before JSON.parse to avoid a round trip
  // and to spare the runner a command it can never answer.
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return jsonError("FILE_TOO_LARGE", "request body exceeds 2 MiB", 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonError("MALFORMED_BODY", "invalid JSON body", 400);
  }
  if (typeof parsed !== "object" || parsed === null) {
    return jsonError("MALFORMED_BODY", "request body must be a JSON object", 400);
  }

  const record = parsed as Record<string, unknown>;
  const payload = validate(record);
  if (payload === undefined) {
    return jsonError("MALFORMED_BODY", "invalid request body", 400);
  }
  return payload;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * `PUT /api/workspaces/:id/file?path=...` — a revision-checked save.
 *
 * The path anchors to the workspace root and is read from the `?path=` query
 * parameter, exactly like the GET file route (Ruling 5: the PUT route must not
 * shadow the GET route, and the capture stays encoded in server.ts). The body
 * carries `content` and `expectedHash`.
 */
export async function handleFileWrite(
  request: Request,
  params: MutationHandlerParams,
  path: string,
): Promise<Response> {
  const ownership = await resolveOwnership(request, params);
  if (!ownership.ok) return ownership.response;

  const payload = await parseMutationBody(request, (record) => {
    const content = record["content"];
    const expectedHash = record["expectedHash"];
    if (!isString(content) || !isString(expectedHash)) return undefined;
    return { op: "file.write" as const, path, content, expectedHash };
  });
  if (payload instanceof Response) return payload;

  return submitRpc(params.options, params.runnerGateway, params.pending, params.dispatcher, {
    runnerId: ownership.runnerId,
    workspaceId: ownership.workspaceId,
    kind: "workspace.file.write",
    payload,
    capability: WRITE_CAPABILITY,
  });
}

/**
 * `POST /api/workspaces/:id/file/revert` — restore one file to its baseline,
 * or delete a file the baseline says was created during the run.
 *
 * Per the brief's test contract, `path` and `expectedHash` travel in the body
 * for the file/revert route (expectedHash is null when the caller believes the
 * path is absent).
 */
export async function handleFileRevert(
  request: Request,
  params: MutationHandlerParams,
): Promise<Response> {
  const ownership = await resolveOwnership(request, params);
  if (!ownership.ok) return ownership.response;

  const payload = await parseMutationBody(request, (record) => {
    const path = record["path"];
    const expectedHash = record["expectedHash"];
    if (!isString(path)) return undefined;
    if (expectedHash !== null && !isString(expectedHash)) return undefined;
    return { op: "file.revert" as const, path, expectedHash };
  });
  if (payload instanceof Response) return payload;

  return submitRpc(params.options, params.runnerGateway, params.pending, params.dispatcher, {
    runnerId: ownership.runnerId,
    workspaceId: ownership.workspaceId,
    kind: "workspace.file.revert",
    payload,
    capability: WRITE_CAPABILITY,
  });
}

/**
 * `POST /api/workspaces/:id/revert` — restore the whole workspace to its
 * run-start baseline, conditioned on the preview digest the operator reviewed.
 */
export async function handleWorkspaceRevert(
  request: Request,
  params: MutationHandlerParams,
): Promise<Response> {
  const ownership = await resolveOwnership(request, params);
  if (!ownership.ok) return ownership.response;

  const payload = await parseMutationBody(request, (record) => {
    const planDigest = record["planDigest"];
    if (!isString(planDigest) || planDigest === "") return undefined;
    return { op: "workspace.revert" as const, planDigest };
  });
  if (payload instanceof Response) return payload;

  return submitRpc(params.options, params.runnerGateway, params.pending, params.dispatcher, {
    runnerId: ownership.runnerId,
    workspaceId: ownership.workspaceId,
    kind: "workspace.revert",
    payload,
    capability: WRITE_CAPABILITY,
  });
}

/** Re-export for the snapshot route, which is an inspect op (§6.2 call 9). */
export { statusForCode };
