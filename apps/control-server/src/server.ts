/**
 * Control server composition (§17, §19.1).
 *
 * Wires the three surfaces onto one `Bun.serve` instance:
 *
 *   GET  /healthz       liveness, no configuration in the response
 *   POST /auth/login    owner login, Origin-checked, sets an HttpOnly cookie
 *   WS   /ws/runner     runner transport, credential in a header
 *   WS   /ws/browser    owner transport, Origin allowlist + session cookie
 *
 * The upgrade decisions live in the gateways; this file only translates HTTP
 * into their inputs and back. Keeping it thin is what lets the gateways be
 * tested without a server.
 */

import type { Database } from "bun:sqlite";
import {
  type CommandOutbox,
  consumeEnrollment,
  createEnrollment,
  issueRunnerCredential,
  Scheduler,
} from "@cc-web/control-db";
import { PROTOCOL_VERSION } from "@cc-web/protocol";
import type { Server } from "bun";
import type { AuthService } from "./auth/auth-service.ts";
import { Dispatcher } from "./dispatch/dispatcher.ts";
import { BrowserGateway, type BrowserSocketData } from "./websocket/browser/browser-gateway.ts";
import { runnerWebSocket, upgradeRunner } from "./websocket/runner/route.ts";
import { RunnerGateway, type RunnerSocketData } from "./websocket/runner/runner-gateway.ts";

export type RunnerCredentialCheck =
  | { ok: true; runnerId: string; ownerId: string }
  | { ok: false; reason: "unknown" | "expired" };

export type ServerOptions = {
  db: Database;
  auth: AuthService;
  allowedOrigins: string[];
  verifyRunnerCredential: (credential: string) => RunnerCredentialCheck;
  /**
   * Verifies a password against the stored hash. Injected because the hash
   * format belongs to the auth library, not to this file.
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

export function createServer(options: ServerOptions): ServerHandle {
  // The gateway and the dispatcher call each other: the gateway reports
  // readiness, the dispatcher sends through the gateway. One has to exist first,
  // so the gateway takes a callback that reads the later binding. Keeping the
  // cycle here rather than inside either class is what lets both be tested on
  // their own.
  let dispatcher: Dispatcher | undefined;

  const runnerGateway = new RunnerGateway({
    policy: { minProtocolVersion: 1, maxProtocolVersion: 1, maxConcurrentRuns: 4 },
    verifyCredential: options.verifyRunnerCredential,
    onReady: (runnerId) => dispatcher?.drain(runnerId),
    onReceipt: (runnerId, receipt) => dispatcher?.handleReceipt(runnerId, receipt),
  });

  if (options.outbox) {
    dispatcher = new Dispatcher({ outbox: options.outbox, gateway: runnerGateway });
  }

  // The scheduler is what the HTTP surface will call. Wiring the drain here
  // means `dispatch()` is a complete operation: decide, persist, deliver.
  const scheduler = new Scheduler(options.db, {
    onDispatched: (runnerId) => dispatcher?.drain(runnerId),
  });

  const browserGateway = new BrowserGateway({
    auth: options.auth,
    allowedOrigins: options.allowedOrigins,
    cookieName: COOKIE_NAME,
  });

  const allowed = new Set(options.allowedOrigins);

  const server = Bun.serve<RunnerSocketData | BrowserSocketData>({
    port: 0,

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

      if (url.pathname === "/api/runner-enrollments" && request.method === "POST") {
        return handleCreateEnrollment(request, options, allowed, browserGateway);
      }

      if (url.pathname === "/api/runner-enroll" && request.method === "POST") {
        return handleRunnerEnroll(request, options);
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
          // Already authorized during the upgrade; nothing to re-check.
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

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // ADR-0001: HttpOnly so script cannot read it, SameSite=Lax so a
      // cross-site form post does not carry it.
      "Set-Cookie": `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ACCESS_TTL_SECONDS}`,
    },
  });
}

function isBrowserSocket(data: unknown): data is BrowserSocketData {
  return typeof data === "object" && data !== null && "userId" in data;
}

/** How long an operator has to paste the token into `runner enroll`. */
const ENROLLMENT_TTL_MS = 10 * 60 * 1000;

/**
 * The owner mints a one-time token (§6.1).
 *
 * Authenticated like any other browser call: Origin first, then the session
 * cookie. A token minted for a hostile page is a token the attacker can redeem,
 * so this check is not optional just because the response contains no user data.
 */
async function handleCreateEnrollment(
  request: Request,
  options: ServerOptions,
  allowedOrigins: ReadonlySet<string>,
  browserGateway: BrowserGateway,
): Promise<Response> {
  const origin = request.headers.get("origin") ?? undefined;
  if (!origin || !allowedOrigins.has(origin)) {
    return new Response("forbidden", { status: 403 });
  }

  const authorized = await browserGateway.authorize({
    origin,
    cookie: request.headers.get("cookie") ?? undefined,
  });
  if (!authorized.ok) {
    return new Response("unauthorized", { status: 401 });
  }

  const created = createEnrollment(options.db, {
    ownerId: authorized.userId,
    ttlMs: ENROLLMENT_TTL_MS,
  });

  // The token is in this response and nowhere else. `no-store` keeps it out of
  // any intermediate cache; the database only ever holds its hash.
  return new Response(
    JSON.stringify({
      token: created.token,
      enrollmentId: created.id,
      expiresAt: created.expiresAt,
    }),
    {
      status: 201,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    },
  );
}

/**
 * A runner redeems a token and receives its credential (§6.1).
 *
 * No Origin and no cookie: this is a CLI on another machine. The token is the
 * whole credential, which is why it is short-lived, single-use, and travels in
 * a body rather than a URL.
 *
 * Unknown, consumed and expired all answer 401. Anything else would turn the
 * endpoint into an oracle for which tokens once existed.
 */
async function handleRunnerEnroll(request: Request, options: ServerOptions): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const token = (body as Record<string, unknown>)["token"];
  if (typeof token !== "string" || token === "") {
    // A non-string token is a client bug, not a credential failure.
    return new Response("bad request", { status: 400 });
  }

  const consumed = consumeEnrollment(options.db, { token });
  if (!consumed.ok) {
    return new Response("unauthorized", { status: 401 });
  }

  const runnerId = `runner_${crypto.randomUUID()}`;
  const issued = issueRunnerCredential(options.db, {
    id: runnerId,
    ownerId: consumed.enrollment.ownerId,
  });

  return new Response(JSON.stringify({ runnerId, credential: issued.credential }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // A credential in a cache is a credential on disk we do not control.
      "Cache-Control": "no-store",
    },
  });
}
