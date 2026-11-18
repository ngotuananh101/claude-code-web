import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  deleteSession,
  listSessions,
  sessionPin,
  updateSessionTitle,
  workspacesForOwner,
} from "@cc-web/control-db";
import { SESSION_CHAT_PAGES_CAPABILITY, SESSIONS_CAPABILITY } from "@cc-web/protocol";
import type { Dispatcher } from "../dispatch/dispatcher.ts";
import type { PendingRpcRequests } from "../rpc/pending-requests.ts";
import type { ServerOptions } from "../server.ts";
import type { BrowserGateway } from "../websocket/browser/browser-gateway.ts";
import type { RunnerGateway } from "../websocket/runner/runner-gateway.ts";
import { jsonError } from "./api-error.ts";
import { resolveAttachmentsDir } from "./attachments-routes.ts";
import { parseCompositeId } from "./inspect-routes.ts";
import { submitRpc } from "./rpc-command.ts";

/**
 * The owner's session list for the sidebar (§16.1).
 *
 * Same authentication as every browser call: Origin first, then the session
 * cookie — the list is scoped to the authorized owner inside `listSessions`,
 * so the query itself is the access rule rather than a filter applied after.
 * `no-store` because the answer is identity-bearing and changes with the
 * journal (§19.4's credential-response rule, applied to the whole surface).
 */
export async function handleListSessions(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
): Promise<Response> {
  // A same-origin GET fetch sends no Origin header at all — the client this
  // route exists for is exactly that request — so a missing Origin is allowed
  // through and the session cookie remains the whole authentication. A
  // present but foreign Origin is refused before anything is read.
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

  return new Response(JSON.stringify({ sessions: listSessions(options.db, authorized.userId) }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * The shared ownership check for the workspace session routes.
 *
 * Runs the origin allowlist, the session-cookie auth, the composite id parse,
 * and the `workspacesForOwner` ownership check. Returns the resolved
 * `{ runnerId, workspaceId }` or a terminal `Response` the caller returns
 * directly — mirroring the `resolveOwnership` idiom from `mutation-routes.ts`.
 */
async function resolveWorkspaceOwnership(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
  compositeId: string,
): Promise<{ runnerId: string; workspaceId: string; path: string } | Response> {
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

  // Resolve the workspace row to forward its canonical path to the runner.
  const ownedWorkspace = workspacesForOwner(options.db, authorized.userId).find(
    (workspace) =>
      workspace.runnerId === parsed.runnerId && workspace.workspaceId === parsed.workspaceId,
  );
  if (ownedWorkspace === undefined) {
    return jsonError("WORKSPACE_NOT_FOUND", "workspace not found", 404);
  }

  return {
    runnerId: ownedWorkspace.runnerId,
    workspaceId: ownedWorkspace.workspaceId,
    path: ownedWorkspace.path,
  };
}

/**
 * `GET /api/workspaces/:workspaceId/sessions`
 *
 * Forwards a `workspace.sessions.list` command to the ready runner that owns
 * the workspace and answers with its `rpc.result`. The `:workspaceId` is the
 * composite `runnerId/workspaceId`, URL-encoded and parsed by
 * `parseCompositeId`. The ownership check reuses `workspacesForOwner` so a
 * custom workspace registered via `POST /api/runners/:runnerId/workspaces` is
 * visible immediately.
 */
export async function handleWorkspaceSessionsList(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
  runnerGateway: RunnerGateway,
  pending: PendingRpcRequests,
  dispatcher: Dispatcher | undefined,
  compositeId: string,
): Promise<Response> {
  const owned = await resolveWorkspaceOwnership(
    request,
    options,
    allowedOrigins,
    browserGateway,
    compositeId,
  );
  if (owned instanceof Response) return owned;

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const offsetParam = url.searchParams.get("offset");

  const payload: { op: "sessions.list"; dir: string; limit?: number; offset?: number } = {
    op: "sessions.list",
    dir: owned.path,
  };
  if (limitParam !== null) {
    const limit = Number.parseInt(limitParam, 10);
    if (!Number.isNaN(limit)) payload.limit = limit;
  }
  if (offsetParam !== null) {
    const offset = Number.parseInt(offsetParam, 10);
    if (!Number.isNaN(offset)) payload.offset = offset;
  }

  return submitRpc(options, runnerGateway, pending, dispatcher, {
    runnerId: owned.runnerId,
    workspaceId: owned.workspaceId,
    kind: "workspace.sessions.list",
    payload,
    capability: SESSIONS_CAPABILITY,
  });
}

/**
 * `GET /api/workspaces/:workspaceId/sessions/:sessionId/messages`
 *
 * Forwards a `workspace.sessions.messages` command to the ready runner that
 * owns the workspace. The `:sessionId` is a Claude Code session id; the runner
 * resolves it against the SDK's session store.
 */
export async function handleWorkspaceSessionMessages(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
  runnerGateway: RunnerGateway,
  pending: PendingRpcRequests,
  dispatcher: Dispatcher | undefined,
  compositeId: string,
  sessionId: string,
): Promise<Response> {
  const owned = await resolveWorkspaceOwnership(
    request,
    options,
    allowedOrigins,
    browserGateway,
    compositeId,
  );
  if (owned instanceof Response) return owned;

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const offsetParam = url.searchParams.get("offset");

  const payload: {
    op: "sessions.messages";
    sessionId: string;
    chatBefore?: number;
    chatSnapshot?: string;
    dir?: string;
    limit?: number;
    offset?: number;
  } = {
    op: "sessions.messages",
    sessionId,
    dir: owned.path,
  };
  if (limitParam !== null) {
    const limit = Number.parseInt(limitParam, 10);
    if (!Number.isNaN(limit)) payload.limit = limit;
  }
  if (offsetParam !== null) {
    const offset = Number.parseInt(offsetParam, 10);
    if (!Number.isNaN(offset)) payload.offset = offset;
  }

  const chatBeforeParam = url.searchParams.get("chatBefore");
  if (chatBeforeParam !== null) {
    const chatBefore = Number(chatBeforeParam);
    if (
      !/^\d+$/.test(chatBeforeParam) ||
      !Number.isSafeInteger(chatBefore) ||
      chatBefore < 0 ||
      offsetParam !== null
    )
      return jsonError("BAD_REQUEST", "invalid chat cursor", 400);
    payload.chatBefore = chatBefore;
  }
  const chatSnapshot = url.searchParams.get("chatSnapshot");
  if (chatSnapshot !== null) {
    if (payload.chatBefore === undefined || chatSnapshot === "" || chatSnapshot.length > 128)
      return jsonError("BAD_REQUEST", "invalid chat snapshot", 400);
    payload.chatSnapshot = chatSnapshot;
  }
  return submitRpc(options, runnerGateway, pending, dispatcher, {
    runnerId: owned.runnerId,
    workspaceId: owned.workspaceId,
    kind: "workspace.sessions.messages",
    payload,
    capability:
      payload.chatBefore === undefined ? SESSIONS_CAPABILITY : SESSION_CHAT_PAGES_CAPABILITY,
  });
}

/**
 * Update a session's title (friendly name).
 */
export async function handleUpdateSessionTitle(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
  sessionId: string,
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
    return jsonError("BAD_REQUEST", "malformed JSON body", 400);
  }

  const title =
    typeof body === "object" &&
    body !== null &&
    "title" in body &&
    typeof (body as { title: unknown }).title === "string"
      ? (body as { title: string }).title
      : "";

  const ok = updateSessionTitle(options.db, sessionId, authorized.userId, title);
  if (!ok) {
    return new Response("not found", { status: 404 });
  }

  return new Response(JSON.stringify({ ok: true, sessionId, title: title.trim() }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Delete a session and its associated history/records.
 *
 * Attachment metadata rows are removed by `deleteSession`; the files on disk are
 * removed here when an explicit `attachmentsDir` was configured, and a
 * `session.cleanup` command is enqueued to the pinned runner so it can reclaim
 * any attachments it holds locally (§4.4).
 */
export async function handleDeleteSession(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
  runnerGateway: RunnerGateway,
  dispatcher: Dispatcher | undefined,
  sessionId: string,
  /**
   * `promoteRunner` from the server wiring: a slot this delete frees has to be
   * refilled from the queue in the same request (§"Admission and promotion").
   * Injected rather than reaching for the scheduler because promoting is
   * promote-then-drain, and the drain is what actually delivers the promoted
   * command — a bare `scheduler.promote` here would leave it `pending`.
   */
  promoteRunner?: (runnerId: string) => void,
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

  // Read the pin before deletion so the session's runner id is known after the
  // row is gone — the pin is what routes the cleanup command.
  const pin = sessionPin(options.db, sessionId);

  const res = deleteSession(options.db, sessionId, authorized.userId);
  if (!res.ok) {
    return new Response("not found", { status: 404 });
  }

  // §"Admission and promotion": every slot release runs promotion immediately.
  // `deleteSession` removed this session's `active_runs` row inside its own
  // transaction, so the slot is already free; the run queued behind it on the
  // same runner must take it in this same request. Without the promote it waits
  // for the next unrelated trigger, which on an idle server is never.
  //
  // Deliberately after the ownership check: releasing before `deleteSession`
  // let a caller delete nothing yet still free another owner's slot.
  if (pin !== undefined) {
    promoteRunner?.(pin.runnerId);
  }

  // §4.4: remove the session's attachment directory on disk if it was configured
  // or exists under the default data directory. The metadata rows are already gone;
  // this reclaims the bytes. Missing-on-disk is not an error — the session may have none.
  const attachmentsDir = resolveAttachmentsDir(options);
  if (res.attachmentStoragePaths.length > 0) {
    const sessionDir = join(attachmentsDir, sessionId);
    rmSync(sessionDir, { recursive: true, force: true });
  }

  // Enroll the pinned runner in cleanup so it deletes any attachments it holds
  // locally. Only a ready runner is addressed — a connected-but-not-ready one
  // has not reconciled and cannot be trusted with the cleanup (§6.2). The command
  // is retired upon `rpc.result` via `onRpcResult` or expires after 60s.
  if (
    pin !== undefined &&
    dispatcher !== undefined &&
    options.outbox !== undefined &&
    runnerGateway.stateOf(pin.runnerId) === "ready"
  ) {
    const commandId = `cmd_${crypto.randomUUID()}`;
    const now = new Date();
    await options.outbox.enqueue({
      commandId,
      runnerId: pin.runnerId,
      kind: "session.cleanup",
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      payload: { sessionId },
      sessionId,
    });
    dispatcher.drain(pin.runnerId);
  }

  return new Response(JSON.stringify({ ok: true, sessionId }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
