import {
  createRunnerToken,
  deleteRunner,
  listRunners,
  revokeRunner,
  type Scheduler,
  updateRunnerName,
} from "@cc-web/control-db";
import type { ServerOptions } from "../server.ts";
import type { BrowserGateway } from "../websocket/browser/browser-gateway.ts";
import type { RunnerGateway } from "../websocket/runner/runner-gateway.ts";
import { jsonError } from "./api-error.ts";

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
  runnerGateway: RunnerGateway,
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

  // Each live runner's advertised models ride along (§5.2), so the composer can
  // list what that host's Claude Code actually offers — including the custom
  // names an operator configured. An offline runner has no live hello, so its
  // list is empty; the composer reads that as "unknown", not "none".
  const runners = listRunners(options.db, authorized.userId).map((runner) => ({
    ...runner,
    models: runnerGateway.modelsOf(runner.runnerId),
  }));

  return new Response(JSON.stringify({ runners }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Revoke a runner (§6.1, §17): kill the credential and drop the live socket.
 *
 * Two halves, both required. The durable half is `revokeRunner`, which stamps
 * `revoked_at` on the runner and every credential it holds in one transaction —
 * that is what makes a reconnect with the same token fail closed, because the
 * upgrade path re-reads the row. The immediate half is `runnerGateway.revoke`,
 * which closes the socket that is live right now and fences its generation, so
 * a revoked runner is not still receiving commands during the second before it
 * notices.
 *
 * 404 for an unknown or foreign id: `revokeRunner` is owner-scoped, so another
 * owner's runner is indistinguishable from a missing one — no existence oracle.
 */
export async function handleRevokeRunner(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
  runnerGateway: RunnerGateway,
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

  const revoked = revokeRunner(options.db, {
    runnerId,
    ownerId: authorized.userId,
  });
  if (!revoked.ok) {
    return new Response("not found", { status: 404 });
  }

  // Only after the durable row landed: a socket closed without the row would
  // reconnect and be accepted again.
  runnerGateway.revoke(runnerId);

  return new Response(JSON.stringify({ runnerId }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Update a runner's name (friendly name).
 */
export async function handleUpdateRunnerName(
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("BAD_REQUEST", "malformed JSON body", 400);
  }

  const name =
    typeof body === "object" &&
    body !== null &&
    "name" in body &&
    typeof (body as { name: unknown }).name === "string"
      ? (body as { name: string }).name
      : "";

  const ok = updateRunnerName(options.db, runnerId, authorized.userId, name);
  if (!ok) {
    return new Response("not found", { status: 404 });
  }

  return new Response(JSON.stringify({ ok: true, runnerId, name: name.trim() }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Delete a runner and cascade delete all its sessions and related data.
 * If runner has an active socket connection, disconnect it.
 */
export async function handleDeleteRunner(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
  runnerGateway: RunnerGateway,
  scheduler: Scheduler,
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

  // Revoke / disconnect live socket if any
  runnerGateway.revoke(runnerId);

  const result = deleteRunner(options.db, runnerId, authorized.userId);
  if (!result.ok) {
    return new Response("not found", { status: 404 });
  }

  // Release any active runs for deleted sessions
  for (const sid of result.deletedSessions) {
    const active = scheduler.activeRunFor(sid);
    if (active) {
      scheduler.release(active.runId);
    }
  }

  return new Response(
    JSON.stringify({ ok: true, runnerId, deletedSessions: result.deletedSessions }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    },
  );
}
