/**
 * The browser-facing schedule surface (§11.5).
 *
 * Schedules are created only through conversation (`CronCreate` mirrored by
 * the runner); these two routes are the user's view — list what is active for
 * a session, cancel one. Both are owner-scoped: the list resolves the session
 * pin and compares owners, the cancel scopes the UPDATE by `owner_id`, and a
 * foreign or unknown id gets the same 404 an unknown session does, so neither
 * route leaks existence.
 */

import { cancelScheduleForOwner, listActiveSchedules, sessionPin } from "@cc-web/control-db";
import type { ServerOptions } from "../server.ts";
import type { BrowserGateway } from "../websocket/browser/browser-gateway.ts";

/** Origin first, then the session cookie — the shape every browser route uses. */
async function authorize(
  request: Request,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
): Promise<{ userId: string } | Response> {
  // A same-origin GET sends no Origin header at all, so a missing Origin is
  // allowed through and the cookie remains the whole authentication; a present
  // but foreign Origin is refused before anything is read.
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
  return { userId: authorized.userId };
}

export async function handleListSchedules(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
  sessionId: string,
): Promise<Response> {
  const authorized = await authorize(request, allowedOrigins, browserGateway);
  if (authorized instanceof Response) return authorized;

  const pin = sessionPin(options.db, sessionId);
  if (pin === undefined || pin.ownerId !== authorized.userId) {
    return new Response("not found", { status: 404 });
  }

  return new Response(JSON.stringify({ schedules: listActiveSchedules(options.db, sessionId) }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function handleCancelSchedule(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
  scheduleId: string,
): Promise<Response> {
  const authorized = await authorize(request, allowedOrigins, browserGateway);
  if (authorized instanceof Response) return authorized;

  if (!cancelScheduleForOwner(options.db, scheduleId, authorized.userId)) {
    return new Response("not found", { status: 404 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
