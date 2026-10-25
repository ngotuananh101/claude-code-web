/**
 * Control server composition (§17, §19.1).
 *
 * Wires the surfaces onto one `Bun.serve` instance:
 *
 *   POST /auth/login    owner login, Origin-checked, sets an HttpOnly cookie
 *   POST /auth/logout   revokes the login and closes its live sockets
 *   GET  /healthz       liveness, no configuration in the response
 *   WS   /ws/runner     runner transport, credential in a header
 *   WS   /ws/browser    owner transport, Origin allowlist + session cookie
 *
 * The upgrade decisions live in the gateways; this file only translates HTTP
 * into their inputs and back. Keeping it thin is what lets the gateways be
 * tested without a server.
 */

import type { Database } from "bun:sqlite";
import {
  attemptWatermark,
  type CommandOutbox,
  createRunnerToken,
  ingestEvent,
  listRunners,
  listSessions,
  readSessionEvents,
  Scheduler,
  sessionEarliest,
  sessionOwner,
  sessionWatermark,
  usageStats,
} from "@cc-web/control-db";
import { PROTOCOL_VERSION } from "@cc-web/protocol";
import type { Server } from "bun";
import type { AuthService } from "./auth/auth-service.ts";
import { Dispatcher } from "./dispatch/dispatcher.ts";
import {
  BrowserGateway,
  type BrowserSocketData,
  type SessionResolver,
} from "./websocket/browser/browser-gateway.ts";
import { runnerWebSocket, upgradeRunner } from "./websocket/runner/route.ts";
import { RunnerGateway, type RunnerSocketData } from "./websocket/runner/runner-gateway.ts";

export type RunnerCredentialCheck =
  | { ok: true; runnerId: string; ownerId: string }
  | { ok: false; reason: "unknown" | "revoked" };

export type ServerOptions = {
  db: Database;
  /** Owner auth (ADR-0001): signs access tokens, checks them against the DB. */
  auth: AuthService;
  allowedOrigins: string[];
  verifyRunnerCredential: (credential: string) => RunnerCredentialCheck;
  /**
   * Password check for /auth/login. Injectable so tests can answer without
   * hashing; production gets `verifyPassword` from auth/password.ts.
   */
  verifyPassword?: (plain: string, hash: string) => Promise<boolean>;
  /**
   * The command outbox. When supplied, a runner that reaches `ready` is drained
   * immediately, so work queued while it was away goes out as part of the
   * reconnect rather than on the next operator action (§14.3 step 4).
   *
   * Optional so a server can be built without persistence — the transport tests
   * do exactly that — but the real entrypoint always passes one.
   */
  outbox?: CommandOutbox;
  /**
   * Fixed listen port. The vite dev proxy needs a stable upstream, so the
   * entrypoint passes one; tests omit it and get an ephemeral port.
   */
  port?: number;
};

export type ServerHandle = {
  server: Server<RunnerSocketData | BrowserSocketData>;
  runnerGateway: RunnerGateway;
  browserGateway: BrowserGateway;
  dispatcher: Dispatcher | undefined;
  scheduler: Scheduler;
  stop(): void;
};

const COOKIE_NAME = "cc_session";
const ACCESS_TTL_SECONDS = 15 * 60;

/**
 * The Cookie header → user id seam the gateway checks on every socket and API
 * read. `AuthService.authenticate` compares the token's version against the
 * database, so this is a live-session check, not a signature check (ADR-0001).
 */
function createJwtSessionResolver(auth: AuthService): SessionResolver {
  return async (cookie) => {
    const result = await auth.authenticate(readCookie(cookie, COOKIE_NAME));
    return result.ok ? result.userId : null;
  };
}

function readCookie(cookie: string | undefined, name: string): string | undefined {
  if (cookie === undefined) return undefined;
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
  }
  return undefined;
}

export function createServer(options: ServerOptions): ServerHandle {
  // The gateway and the dispatcher call each other: the gateway reports
  // readiness, the dispatcher sends through the gateway. One has to exist first,
  // so the gateway takes a callback that reads the later binding. Keeping the
  // cycle here rather than inside either class is what lets both be tested on
  // their own.
  let dispatcher: Dispatcher | undefined;

  // Built first so the runner gateway's ingest hook can broadcast into it
  // without a later-binding dance: browser replay (§12.5) is downstream of
  // journaling (§12.2), not the other way around.
  const browserGateway = new BrowserGateway({
    resolveSession: createJwtSessionResolver(options.auth),
    allowedOrigins: options.allowedOrigins,
    resolveOwner: (sessionId) => sessionOwner(options.db, sessionId),
    readReplay: (sessionId, after, limit) =>
      readSessionEvents(options.db, sessionId, { after, limit }),
    replayBounds: (sessionId) => ({
      watermark: sessionWatermark(options.db, sessionId),
      earliest: sessionEarliest(options.db, sessionId),
    }),
  });

  const runnerGateway = new RunnerGateway({
    policy: { minProtocolVersion: 1, maxProtocolVersion: 1, maxConcurrentRuns: 4 },
    verifyCredential: options.verifyRunnerCredential,
    onReady: (runnerId) => dispatcher?.drain(runnerId),
    onReceipt: (runnerId, receipt) => dispatcher?.handleReceipt(runnerId, receipt),
    // §12.1, §12.2: journal every event before any ACK is written, and let the
    // ACK carry only the contiguous watermark the journal can vouch for. A resend
    // of what already committed answers `duplicate` and allocates nothing, which
    // is what makes a lost ACK heal itself instead of doubling the journal.
    onEvents: (_runnerId, events) => {
      const stored: Array<{ event: (typeof events)[number]; sessionSequence: number }> = [];
      for (const event of events) {
        const result = ingestEvent(options.db, event);
        if (result.status === "stored" && result.sessionSequence !== undefined) {
          stored.push({ event, sessionSequence: result.sessionSequence });
        }
      }

      // Broadcast only what committed (§12.2): a duplicate's re-broadcast would
      // be deduplicated by every client anyway, and a conflict is never content.
      // This runs after each ingest transaction, so a failed broadcast costs a
      // live frame — never an event, which the journal still holds.
      for (const { event, sessionSequence } of stored) {
        browserGateway.publish({
          sessionId: event.sessionId,
          sessionSequence,
          eventId: event.eventId,
          runId: event.runId,
          attemptId: event.attemptId,
          occurredAt: event.occurredAt,
          type: event.type,
          payload: event.payload,
        });

        // §11.3: the session's one slot frees when a terminal event commits —
        // the journal is the authority on outcomes, so a lost socket can never
        // strand a session in `session_busy` forever.
        if (
          event.type === "run.finished" ||
          event.type === "run.failed" ||
          event.type === "run.interrupted"
        ) {
          scheduler.release(event.runId);
        }
      }

      const attempts = new Set(events.map((event) => event.attemptId));
      return [...attempts].map((attemptId) => ({
        attemptId,
        through: attemptWatermark(options.db, attemptId),
      }));
    },
  });

  if (options.outbox) {
    dispatcher = new Dispatcher({ outbox: options.outbox, gateway: runnerGateway });
  }

  // The scheduler is what the HTTP surface will call. Wiring the drain here
  // means `dispatch()` is a complete operation: decide, persist, deliver.
  const scheduler = new Scheduler(options.db, {
    onDispatched: (runnerId) => dispatcher?.drain(runnerId),
  });

  const allowed = new Set(options.allowedOrigins);

  const server = Bun.serve<RunnerSocketData | BrowserSocketData>({
    port: options.port ?? 0,

    async fetch(request, srv) {
      const url = new URL(request.url);

      if (url.pathname === "/healthz") {
        // Deliberately says nothing about configuration: a health endpoint is
        // usually unauthenticated.
        return Response.json({ ok: true, protocolVersion: PROTOCOL_VERSION });
      }

      if (url.pathname === "/auth/login" && request.method === "POST") {
        return handleLogin(request, options, allowed);
      }

      if (url.pathname === "/auth/logout" && request.method === "POST") {
        return handleLogout(request, options, allowed, browserGateway);
      }

      if (url.pathname === "/api/runners" && request.method === "POST") {
        return handleCreateRunner(request, options, allowed, browserGateway);
      }

      if (url.pathname === "/api/runners" && request.method === "GET") {
        return handleListRunners(request, options, allowed, browserGateway);
      }

      if (url.pathname === "/api/sessions" && request.method === "GET") {
        return handleListSessions(request, options, allowed, browserGateway);
      }

      if (url.pathname === "/api/stats/usage" && request.method === "GET") {
        return handleUsageStats(request, options, allowed, browserGateway);
      }

      if (url.pathname === "/api/me" && request.method === "GET") {
        return handleMe(request, options, allowed, browserGateway);
      }

      const runsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/runs$/);
      if (runsMatch && request.method === "POST") {
        return handleDispatchRun(
          request,
          options,
          allowed,
          browserGateway,
          runnerGateway,
          scheduler,
          decodeURIComponent(runsMatch[1] ?? ""),
        );
      }

      const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      if (cancelMatch && request.method === "POST") {
        return handleCancelRun(
          request,
          allowed,
          browserGateway,
          scheduler,
          decodeURIComponent(cancelMatch[1] ?? ""),
        );
      }

      if (url.pathname === "/ws/runner") {
        const upgraded = upgradeRunner(request, srv as Server<RunnerSocketData>, runnerGateway);
        return upgraded.ok ? undefined : new Response("refused", { status: upgraded.status });
      }

      if (url.pathname === "/ws/browser") {
        // §19.1: the Origin check happens before the upgrade, so a hostile page
        // cannot even establish the socket it would then be refused on.
        const origin = request.headers.get("origin") ?? undefined;
        if (!origin || !allowed.has(origin)) {
          return new Response("forbidden", { status: 403 });
        }

        const authorized = await browserGateway.authorize({
          origin,
          cookie: request.headers.get("cookie") ?? undefined,
        });

        if (!authorized.ok) {
          return new Response("unauthorized", { status: 401 });
        }

        const upgraded = srv.upgrade(request, {
          data: {
            userId: authorized.userId,
            authenticated: true,
            subscriptions: new Set<string>(),
          } satisfies BrowserSocketData,
        });
        return upgraded ? undefined : new Response("bad request", { status: 400 });
      }

      return new Response("not found", { status: 404 });
    },

    websocket: {
      ...runnerWebSocket(runnerGateway),
      // Bun dispatches one handler object per server, so the browser path is
      // distinguished by socket data rather than by handler.
      open(socket) {
        if (isBrowserSocket(socket.data)) {
          // Authorized during the upgrade — but still registered, so publish
          // (§12.5) and revocation can reach this socket by user.
          browserGateway.register(socket as never);
          return;
        }
        runnerGateway.attach(socket as never, socket.data as RunnerSocketData);
      },
      message(socket, message) {
        if (isBrowserSocket(socket.data)) {
          browserGateway.handleMessage(socket as never, message);
          return;
        }
        runnerGateway.handleMessage(socket as never, message);
      },
      close(socket) {
        if (isBrowserSocket(socket.data)) {
          browserGateway.handleClose(socket as never);
          return;
        }
        runnerGateway.handleClose(socket as never);
      },
    },
  });

  return {
    server,
    runnerGateway,
    browserGateway,
    dispatcher,
    scheduler,
    stop: () => server.stop(true),
  };
}

function isBrowserSocket(data: unknown): data is BrowserSocketData {
  return typeof data === "object" && data !== null && "userId" in data;
}

async function handleLogin(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
): Promise<Response> {
  // Origin first: a correct password from a hostile page must not mint a
  // session, and the check must not depend on the password being wrong.
  const origin = request.headers.get("origin") ?? undefined;
  if (!origin || !allowedOrigins.has(origin)) {
    return new Response("forbidden", { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const record = body as Record<string, unknown>;
  const username = record["username"];
  const password = record["password"];
  if (typeof username !== "string" || typeof password !== "string") {
    return new Response("bad request", { status: 400 });
  }

  const row = options.db
    .query("SELECT id, password_hash FROM users WHERE username = ?")
    .get(username) as { id: string; password_hash: string } | null;

  // One response for "no such user" and "wrong password": distinguishing them
  // turns the endpoint into a username oracle.
  const verify = options.verifyPassword ?? (async () => false);
  const ok = row ? await verify(password, row.password_hash) : false;
  if (!row || !ok) {
    return new Response("unauthorized", { status: 401 });
  }

  const token = await options.auth.issueAccessToken(row.id);

  // Secure only when the request is actually https: on a plain-http origin
  // (local dev, self-hosted LAN) a Secure cookie is dropped by the browser,
  // which would turn every login into a silent no-op. The flag still does
  // its real work wherever TLS terminates at this server.
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // ADR-0001: HttpOnly so script cannot read it, SameSite=Lax so a
      // cross-site form post does not carry it.
      "Set-Cookie": `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ACCESS_TTL_SECONDS}${secure}`,
    },
  });
}

/**
 * Sign-out (§12.5 + ADR-0001). Bumping the token version kills every
 * outstanding access token with this one request; `revoke` closes the live
 * sockets the login opened so a signed-out tab stops streaming immediately.
 */
async function handleLogout(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
): Promise<Response> {
  const origin = request.headers.get("origin") ?? undefined;
  if (origin !== undefined && !allowedOrigins.has(origin)) {
    return new Response("forbidden", { status: 403 });
  }

  const authorized = await browserGateway.authorize({
    origin,
    cookie: request.headers.get("cookie") ?? undefined,
  });
  if (!authorized.ok) {
    return new Response("unauthorized", { status: 401 });
  }

  options.auth.revokeAllSessions(authorized.userId);
  browserGateway.revoke(authorized.userId);

  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
    },
  });
}

/**
 * The owner mints a runner's connector token (§6.1, cloudflared-style).
 *
 * Authenticated like any other browser call: Origin first, then the session
 * cookie. A token minted for a hostile page is a token the attacker can redeem,
 * so this check is not optional just because the response contains no user data.
 */
async function handleCreateRunner(
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
 * The signed-in account's own name for the rail's footer (§16.2). The footer
 * cannot hardcode it: the operator seeds whatever username they choose.
 *
 * Same authentication as every browser call: Origin allowlist, then the
 * session cookie. `no-store` because the answer is identity-bearing (§19.4).
 */
async function handleMe(
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

  const row = options.db
    .query("SELECT username FROM users WHERE id = ?")
    .get(authorized.userId) as { username: string } | null;
  if (row === null) {
    // authenticate() proved the token names a live row; treat anything else
    // as no session rather than guessing at an account to show.
    return new Response("unauthorized", { status: 401 });
  }

  return new Response(JSON.stringify({ username: row.username }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * The owner's runner list.
 *
 * Same authentication as every browser call: Origin first, then the session
 * cookie. `listRunners` answers with ids and lifecycle timestamps only — no
 * secret material exists to leak, because no plaintext token was ever stored.
 * `no-store` because the answer is identity-bearing (§19.4).
 */
async function handleListRunners(
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

  return new Response(JSON.stringify({ runners: listRunners(options.db) }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * The owner's session list for the sidebar (§16.1).
 *
 * Same authentication as every browser call: Origin first, then the session
 * cookie — the list is scoped to the authorized owner inside `listSessions`,
 * so the query itself is the access rule rather than a filter applied after.
 * `no-store` because the answer is identity-bearing and changes with the
 * journal (§19.4's credential-response rule, applied to the whole surface).
 */
async function handleListSessions(
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
 * The dashboard's usage read (token in/cache/out totals, a daily series,
 * volume counts). Same authentication shape as the session list: Origin
 * first, then the cookie, and the aggregation is scoped to the authorized
 * owner inside `usageStats` — the query is the access rule.
 */
async function handleUsageStats(
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

  return new Response(JSON.stringify(usageStats(options.db, authorized.userId)), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Submit a prompt as a run (§17.1): decide, persist, deliver — all inside
 * scheduler.dispatch — and answer 202 with the ids the journal will use.
 *
 * Runner selection is the §11.3 MVP: the owner's runners in creation order,
 * first one the gateway reports `ready`. No placement beyond that, and the
 * capacity base is one concurrent run, which is what §11.3 sizes the MVP at.
 */
async function handleDispatchRun(
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
 * Cancel an active run (§17.1, §14.2): a durable request enqueued to the
 * holding runner, not an in-memory abort. 404 for a run nobody is holding —
 * an already-finished run needs no cancel, and inventing one would promise
 * delivery the outbox cannot keep.
 */
async function handleCancelRun(
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
