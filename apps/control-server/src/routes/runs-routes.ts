import { type Scheduler, sessionPin } from "@cc-web/control-db";
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
 * Placement (§15.1, §11.3): the runners declare their workspaces, and a body
 * that names one is pinned to that set — the candidate runners are the owner's
 * who declare the workspace, the earliest-ready wins. A `runnerId` in the body
 * must be the owner's own runner and must declare the workspace it is being
 * asked to run in. A body that names neither keeps the §11.3 MVP: the owner's
 * runners in creation order, first one the gateway reports `ready`. The
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

  const record = body as {
    prompt?: unknown;
    workspaceId?: unknown;
    permissionMode?: unknown;
    model?: unknown;
    runnerId?: unknown;
  };
  const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
  if (prompt === "") {
    return new Response("bad request", { status: 400 });
  }
  const workspaceId =
    typeof record.workspaceId === "string" && record.workspaceId.trim() !== ""
      ? record.workspaceId
      : "default";

  // §13: the permission mode is the operator's standing choice for this run.
  // An unknown value is refused, not silently defaulted — a typo asking for
  // "bypassPermissions" must never run at "default" and vice versa.
  const PERMISSION_MODES: ReadonlySet<string> = new Set([
    "default",
    "acceptEdits",
    "bypassPermissions",
    "plan",
  ]);
  let permissionMode: string | undefined;
  if (record.permissionMode !== undefined) {
    if (typeof record.permissionMode !== "string" || !PERMISSION_MODES.has(record.permissionMode)) {
      return new Response("bad request", { status: 400 });
    }
    permissionMode = record.permissionMode;
  }

  // §5.2: the model is a per-run choice over the names §8.1 fixes. Same rule as
  // the permission mode — a typo must be refused, not silently run on a model
  // the operator did not ask for.
  const MODELS: ReadonlySet<string> = new Set(["sonnet", "opus", "haiku"]);
  let model: string | undefined;
  if (record.model !== undefined) {
    if (typeof record.model !== "string" || !MODELS.has(record.model)) {
      return new Response("bad request", { status: 400 });
    }
    model = record.model;
  }

  // §2.3/ADR-006: a session's first accepted dispatch pinned it to a
  // (workspace, runner) pair, and every later run rides that pin. The pin is
  // the placement decision — made once, made durably.
  const pin = sessionPin(options.db, sessionId);
  if (pin !== undefined && pin.ownerId !== authorized.userId) {
    // Existence is not another user's to learn: 404 before any other signal,
    // including session_busy.
    return new Response("not found", { status: 404 });
  }
  if (pin !== undefined) {
    // A contradiction between the body and the pin is its own refusal — the
    // operator is asking to move a session, which §21.6 migration will own.
    // Absent or blank choices are not contradictions: they ride the pin. A
    // non-string runnerId is not a contradiction but malformed input, and the
    // 400 below reads it as such.
    if (typeof record.runnerId === "string" && record.runnerId !== pin.runnerId) {
      return new Response("session_pinned", { status: 409 });
    }
    if (
      typeof record.workspaceId === "string" &&
      record.workspaceId.trim() !== "" &&
      record.workspaceId !== pin.workspaceId
    ) {
      return new Response("session_pinned", { status: 409 });
    }
  }

  // §15.1: an explicit runner pin for a NEW session. A non-string is malformed
  // input; a string that is not the owner's own live runner is refused with
  // its own code — a run must never silently land somewhere the operator did
  // not pin. (A pinned session skips this entirely: its pin was validated
  // when it was written.)
  let runnerId: string | undefined;
  if (typeof record.runnerId !== "string" && record.runnerId !== undefined) {
    return new Response("bad request", { status: 400 });
  }
  if (pin !== undefined) {
    // Trust the pin, not the declarations: workspace drift must never brick a
    // resume (ADR-006), so there are no candidate or declaration checks here.
    // The pinned runner must still be the owner's live one — revoked is as
    // good as gone, and the session waits rather than failing over.
    const pinned = options.db
      .query("SELECT revoked_at FROM runners WHERE id = ? AND owner_id = ?")
      .get(pin.runnerId, authorized.userId) as { revoked_at: number | null } | null;
    if (pinned === null || pinned.revoked_at !== null) {
      return new Response("runner_offline", { status: 503 });
    }
    runnerId = pin.runnerId;
  } else if (record.runnerId !== undefined) {
    const owned = options.db
      .query("SELECT id FROM runners WHERE id = ? AND owner_id = ? AND revoked_at IS NULL")
      .get(record.runnerId, authorized.userId) as { id: string } | null;
    if (owned === null) {
      return new Response("unknown_runner", { status: 400 });
    }
    runnerId = record.runnerId;
  }

  // Checked before runner selection so a double-submit answers with its own
  // cause: the session is busy, not "no runner could take it" (§2.3).
  if (scheduler.activeRunFor(sessionId)) {
    return new Response("session_busy", { status: 409 });
  }

  // Candidates, in creation order — NEW sessions only. A workspace in the
  // body narrows them to the runners that declare it (§15.1: the runner is
  // the registration authority) — a workspaceId nobody declared must never
  // widen into "any ready runner". The 4xx refusals come before readiness on
  // purpose: a placement that cannot work is a client error even when a
  // runner happens to be down. A pinned session never sees this code: its
  // placement was decided once, at pin time.
  let candidates: Array<{ id: string }> = [];
  if (pin === undefined) {
    if (typeof record.workspaceId === "string" && record.workspaceId.trim() !== "") {
      candidates = options.db
        .query(
          `SELECT r.id FROM runners r
           JOIN workspaces w ON w.runner_id = r.id
           WHERE r.owner_id = ? AND r.revoked_at IS NULL AND w.workspace_id = ?
           ORDER BY r.created_at`,
        )
        .all(authorized.userId, workspaceId) as Array<{ id: string }>;
      if (candidates.length === 0) {
        return new Response("unknown_workspace", { status: 400 });
      }
      if (runnerId !== undefined && !candidates.some((row) => row.id === runnerId)) {
        return new Response("unknown_workspace", { status: 400 });
      }
    } else {
      candidates = options.db
        .query(
          "SELECT id FROM runners WHERE owner_id = ? AND revoked_at IS NULL ORDER BY created_at",
        )
        .all(authorized.userId) as Array<{ id: string }>;
    }
  }

  let ready: string | undefined;
  let connected = false;
  if (runnerId !== undefined) {
    const state = runnerGateway.stateOf(runnerId);
    if (state === "ready") ready = runnerId;
    else if (state === "connected") connected = true;
  } else {
    for (const row of candidates) {
      const state = runnerGateway.stateOf(row.id);
      if (state === "ready") {
        ready = row.id;
        break;
      }
      if (state === "connected") connected = true;
    }
  }
  if (ready === undefined) {
    // §17.3: never hold the request on an offline runner. The reason tells the
    // operator which half is missing — nothing connected, or a connection that
    // has not reconciled yet (§6.2).
    return new Response(connected ? "runner_not_ready" : "runner_offline", { status: 503 });
  }

  const runId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  // The payload carries the pin's workspace for a pinned session: a
  // prompt-only rerun must run where the session lives, not where a fresh
  // session would have landed.
  const decision = await scheduler.dispatch(
    {
      sessionId,
      runId,
      attemptId,
      workspaceId: pin !== undefined ? pin.workspaceId : workspaceId,
      prompt,
      ownerId: authorized.userId,
      ...(permissionMode === undefined ? {} : { permissionMode }),
      ...(model === undefined ? {} : { model }),
    },
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
