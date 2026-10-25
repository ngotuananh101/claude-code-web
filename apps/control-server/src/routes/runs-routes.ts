import type { Scheduler } from "@cc-web/control-db";
import type { ServerOptions } from "../server.ts";
import type { BrowserGateway } from "../websocket/browser/browser-gateway.ts";
import type { RunnerGateway } from "../websocket/runner/runner-gateway.ts";

/**
 * The browser's run surface over HTTP (§17.1): submit a prompt, cancel a run.
 */

/**
 * Submit a prompt as a run: decide, persist, deliver — all inside
 * scheduler.dispatch — and answer 202 with the ids the journal will use.
 *
 * Runner selection is the §11.3 MVP: the owner's runners in creation order,
 * first one the gateway reports `ready`. No placement beyond that, and the
 * capacity base is one concurrent run, which is what §11.3 sizes the MVP at.
 */
export async function handleDispatchRun(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
  runnerGateway: RunnerGateway,
  scheduler: Scheduler,
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
    return new Response("bad request", { status: 400 });
  }

  const record = body as { prompt?: unknown; workspaceId?: unknown };
  const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
  if (prompt === "") {
    return new Response("bad request", { status: 400 });
  }
  const workspaceId =
    typeof record.workspaceId === "string" && record.workspaceId.trim() !== ""
      ? record.workspaceId
      : "default";

  // Checked before runner selection so a double-submit answers with its own
  // cause: the session is busy, not "no runner could take it" (§2.3).
  if (scheduler.activeRunFor(sessionId)) {
    return new Response("session_busy", { status: 409 });
  }

  const rows = options.db
    .query("SELECT id FROM runners WHERE owner_id = ? AND revoked_at IS NULL ORDER BY created_at")
    .all(authorized.userId) as Array<{ id: string }>;

  let ready: string | undefined;
  let connected = false;
  for (const row of rows) {
    const state = runnerGateway.stateOf(row.id);
    if (state === "ready") {
      ready = row.id;
      break;
    }
    if (state === "connected") connected = true;
  }
  if (ready === undefined) {
    // §17.3: never hold the request on an offline runner. The reason tells the
    // operator which half is missing — nothing connected, or a connection that
    // has not reconciled yet (§6.2).
    return new Response(connected ? "runner_not_ready" : "runner_offline", { status: 503 });
  }

  const runId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const decision = await scheduler.dispatch(
    { sessionId, runId, attemptId, workspaceId, prompt },
    scheduler.capacityFor(ready, {
      runnerId: ready,
      state: "ready",
      maxConcurrentRuns: 1,
      activeRuns: 0,
    }),
  );

  if (!decision.ok) {
    const status =
      decision.reason === "session_busy" || decision.reason === "duplicate_run" ? 409 : 503;
    return new Response(decision.reason, { status });
  }

  return new Response(JSON.stringify({ runId, attemptId, sessionId, runnerId: ready }), {
    status: 202,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Cancel an active run (§14.2): a durable request enqueued to the holding
 * runner, not an in-memory abort. 404 for a run nobody is holding — an
 * already-finished run needs no cancel, and inventing one would promise
 * delivery the outbox cannot keep.
 */
export async function handleCancelRun(
  request: Request,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
  scheduler: Scheduler,
  runId: string,
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

  const decision = await scheduler.cancel(runId);
  if (!decision.ok) {
    return new Response("not found", { status: 404 });
  }

  return new Response(JSON.stringify({ runId, commandId: decision.commandId }), {
    status: 202,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
