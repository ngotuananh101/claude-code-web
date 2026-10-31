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
 * The HTTP handlers live in ./routes (one module per surface); the upgrade
 * decisions live in the gateways. This file only translates HTTP into their
 * inputs and back. Keeping it thin is what lets the handlers and gateways be
 * tested without a server.
 */

import type { Database } from "bun:sqlite";
import {
  attemptWatermark,
  type CommandOutbox,
  ingestEvent,
  projectScheduleEvent,
  readSessionEvents,
  reopenRejectedSchedule,
  Scheduler,
  sessionEarliest,
  sessionOwner,
  sessionWatermark,
  upsertRunnerWorkspaces,
} from "@cc-web/control-db";
import { PROTOCOL_VERSION, RunRegistry, WS_MAX_PAYLOAD_BYTES } from "@cc-web/protocol";
import type { Server } from "bun";
import { abandonAttemptApprovals } from "./approvals/abandon.ts";
import { projectApprovalEvent } from "./approvals/ingest.ts";
import type { AuthService } from "./auth/auth-service.ts";
import { Dispatcher } from "./dispatch/dispatcher.ts";
import { handleApprovalDecision } from "./routes/approvals-routes.ts";
import {
  handleGetAttachment,
  handleGetRunnerAttachment,
  handleUploadAttachments,
} from "./routes/attachments-routes.ts";
import {
  COOKIE_NAME,
  handleLogin,
  handleLogout,
  handleRefresh,
  handleSetup,
  handleSetupStatus,
  readCookie,
} from "./routes/auth-routes.ts";
import { handleBrowse, handleRegisterWorkspace } from "./routes/browse-routes.ts";
import { handleInspect } from "./routes/inspect-routes.ts";
import { handleMe } from "./routes/me-routes.ts";
import {
  handleFileRevert,
  handleFileWrite,
  handleWorkspaceRevert,
} from "./routes/mutation-routes.ts";
import {
  handleCreateRunner,
  handleDeleteRunner,
  handleListRunners,
  handleRevokeRunner,
  handleUpdateRunnerName,
} from "./routes/runners-routes.ts";
import { handleCancelRun, handleDispatchRun } from "./routes/runs-routes.ts";
import { handleCancelSchedule, handleListSchedules } from "./routes/schedules-routes.ts";
import {
  handleDeleteSession,
  handleListSessions,
  handleUpdateSessionTitle,
  handleWorkspaceSessionMessages,
  handleWorkspaceSessionsList,
} from "./routes/sessions-routes.ts";
import { handleUsageStats } from "./routes/stats-routes.ts";
import { handleListWorkspaces } from "./routes/workspaces-routes.ts";
import { PendingRpcRequests } from "./rpc/pending-requests.ts";
import { startScheduleLoop } from "./scheduling/schedule-loop.ts";
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
   * Password hash for /auth/setup. Injectable so tests can stub hashing;
   * production gets `hashPassword` from auth/password.ts.
   */
  hashPassword?: (plain: string) => Promise<string>;
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
  /**
   * Directory that stores uploaded attachment files on disk (§4.4). When absent
   * the server defaults to `./data/attachments` under its CWD.
   */
  attachmentsDir?: string;
  /**
   * Injectable tick interval for the scheduling loop (§11.5) — tests push it
   * out of reach so a tick can never race their assertions. Production omits
   * it and gets the loop's 15s default.
   */
  scheduleTickMs?: number;
};

export type ServerHandle = {
  server: Server<RunnerSocketData | BrowserSocketData>;
  runnerGateway: RunnerGateway;
  browserGateway: BrowserGateway;
  dispatcher: Dispatcher | undefined;
  scheduler: Scheduler;
  stop(): void;
};

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

  // The run registry is shared with the ingest hook so approval events can
  // suspend and resume runs (§13) in the same state the reconcile inventory
  // reports (§14.3). The gateway would otherwise own a private one.
  const runs = new RunRegistry();

  const runnerGateway = new RunnerGateway({
    runs,
    policy: { minProtocolVersion: 1, maxProtocolVersion: 1, maxConcurrentRuns: 4 },
    verifyCredential: options.verifyRunnerCredential,
    onReady: (runnerId) => dispatcher?.drain(runnerId),
    onReceipt: (runnerId, receipt) => dispatcher?.handleReceipt(runnerId, receipt),
    // §14.3: an abandoned approval's cards must not sit pending forever. The
    // projection closes the rows here, CAS-only, when reconciliation proves the
    // runner's gate is gone — and because no `approval.expired` will ever
    // arrive from that gate, the server journals and broadcasts one itself
    // (§13.1: every non-user terminal is emitted).
    onAbandonApproval: (_runnerId, action) => {
      abandonAttemptApprovals({
        db: options.db,
        attemptId: action.attemptId,
        publish: (event) => browserGateway.publish(event),
      });
    },
    // §15.1: the runner's hello/reconcile declaration replaces its rows — the
    // registration path §11.1 defers to, so the composer can list real
    // workspaces without a separate registration API.
    //
    // A storage failure is logged here, where the runner and the failure are
    // both in hand, and then rethrown: the gateway answers the hello/reconcile
    // with `workspaces_unavailable` instead of negotiating a declaration this
    // server could not keep.
    onWorkspaces: (runnerId, workspaces) => {
      try {
        upsertRunnerWorkspaces(options.db, runnerId, workspaces);
      } catch (error) {
        console.error(
          `workspace declaration from runner ${runnerId} was not stored: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        throw error;
      }
    },
    // §23: a well-formed `rpc.result` answers the HTTP request that is waiting
    // for it. The gateway deliberately knows nothing about the registry; a
    // frame with no waiter is dropped (the caller may have timed out a
    // millisecond earlier, and that race is expected).
    //
    // Also retires the command in the outbox if present (e.g. fire-and-forget
    // RPCs like `session.cleanup` that have no HTTP waiter).
    onRpcResult: (_runnerId, frame) => {
      if (options.outbox) {
        try {
          if (frame.ok) {
            options.outbox.markAnswered(frame.commandId);
          } else {
            options.outbox.markRejected(frame.commandId, frame.error?.code ?? "unknown_error");
          }
        } catch {
          // Row is not in the outbox, or is already terminal — safe to ignore.
        }
      }
      pending.settle(frame);
    },
    // §12.1, §12.2: journal every event before any ACK is written, and let the
    // ACK carry only the contiguous watermark the journal can vouch for. A resend
    // of what already committed answers `duplicate` and allocates nothing, which
    // is what makes a lost ACK heal itself instead of doubling the journal.
    onEvents: (runnerId, events) => {
      const stored: Array<{ event: (typeof events)[number]; sessionSequence: number }> = [];
      for (const event of events) {
        const result = ingestEvent(options.db, event);
        if (result.status === "stored" && result.sessionSequence !== undefined) {
          stored.push({ event, sessionSequence: result.sessionSequence });
        }
        // §13.1: the approval projection and the registry transition are
        // idempotent, so they run for duplicates too — a redelivered event
        // heals a projection a crash skipped. A conflict projects nothing.
        if (result.status !== "conflict") {
          projectApprovalEvent(options.db, runs, event);
          // §11.5: the schedule mirror follows the same rule — duplicate
          // deliveries are safe (the projection is INSERT OR IGNORE keyed by
          // attempt + tool call), so every non-conflict event is projected.
          // The authenticated runner id is passed through because a schedule
          // row becomes work on the pin's runner: only that runner may
          // create one for the session (§11.5 trust boundary).
          projectScheduleEvent(options.db, event, runnerId);
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
    const outbox = options.outbox;
    dispatcher = new Dispatcher({
      outbox,
      gateway: runnerGateway,
      onRejectedStart: (runId, commandId, reason) => {
        scheduler.release(runId);
        // §11.5: a scheduled one-shot the runner refused never ran. Its slot
        // is unspent, so put the row back for the next tick instead of losing
        // the only fire silently. A mark that the run does not belong to a
        // schedule, or that it already started, reopens nothing.
        reopenRejectedSchedule(options.db, outbox, { commandId, runId });
        console.warn(`runner rejected run.start ${commandId} for run ${runId}: ${reason}`);
      },
    });
  }

  // Read-only inspection waiters (§23). In memory by design (Ruling 3): the
  // waiter IS the HTTP request, which cannot outlive the process. The gateway
  // learns nothing about the registry — it hands every well-formed `rpc.result`
  // over, and a frame with no waiter is dropped.
  const pending = new PendingRpcRequests();

  // The scheduler is what the HTTP surface will call. Wiring the drain here
  // means `dispatch()` is a complete operation: decide, persist, deliver.
  const scheduler = new Scheduler(options.db, {
    onDispatched: (runnerId) => dispatcher?.drain(runnerId),
  });

  // §11.5: the server owns the clock. The loop dispatches due schedules as
  // ordinary runs through the same scheduler — capacity, pins and the outbox
  // all behave exactly as they do for a user-started run.
  const scheduleLoop = startScheduleLoop({
    db: options.db,
    scheduler,
    runnerGateway,
    ...(options.scheduleTickMs === undefined ? {} : { intervalMs: options.scheduleTickMs }),
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

      if (url.pathname === "/auth/refresh" && request.method === "POST") {
        return handleRefresh(request, options, allowed);
      }

      if (url.pathname === "/auth/setup-status" && request.method === "GET") {
        return handleSetupStatus(request, options, allowed);
      }

      if (url.pathname === "/auth/setup" && request.method === "POST") {
        return handleSetup(request, options, allowed);
      }

      if (url.pathname === "/api/runners" && request.method === "POST") {
        return handleCreateRunner(request, options, allowed, browserGateway);
      }

      if (url.pathname === "/api/runners" && request.method === "GET") {
        return handleListRunners(request, options, allowed, browserGateway, runnerGateway);
      }

      const revokeMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/revoke$/);
      if (revokeMatch && request.method === "POST") {
        return handleRevokeRunner(
          request,
          options,
          allowed,
          browserGateway,
          runnerGateway,
          decodeURIComponent(revokeMatch[1] ?? ""),
        );
      }

      // Browse and workspace registration (§23 Task 8). The runner id is a plain
      // segment; the path to browse comes from `?path=`.
      const browseMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/browse$/);
      if (browseMatch && request.method === "GET") {
        return handleBrowse(
          request,
          options,
          allowed,
          browserGateway,
          runnerGateway,
          pending,
          dispatcher,
          decodeURIComponent(browseMatch[1] ?? ""),
        );
      }

      const registerWorkspaceMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/workspaces$/);
      if (registerWorkspaceMatch && request.method === "POST") {
        return handleRegisterWorkspace(
          request,
          options,
          allowed,
          browserGateway,
          decodeURIComponent(registerWorkspaceMatch[1] ?? ""),
        );
      }

      const runnerMatch = url.pathname.match(/^\/api\/runners\/([^/]+)$/);
      if (runnerMatch) {
        const runnerId = decodeURIComponent(runnerMatch[1] ?? "");
        if (request.method === "PATCH") {
          return handleUpdateRunnerName(request, options, allowed, browserGateway, runnerId);
        }
        if (request.method === "DELETE") {
          return handleDeleteRunner(
            request,
            options,
            allowed,
            browserGateway,
            runnerGateway,
            scheduler,
            runnerId,
          );
        }
      }

      if (url.pathname === "/api/sessions" && request.method === "GET") {
        return handleListSessions(request, options, allowed, browserGateway);
      }

      // Upload attachments for a session: POST /api/sessions/:sessionId/attachments
      const sessionAttachmentsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/attachments$/);
      if (sessionAttachmentsMatch && request.method === "POST") {
        return handleUploadAttachments(
          request,
          options,
          allowed,
          browserGateway,
          decodeURIComponent(sessionAttachmentsMatch[1] ?? ""),
        );
      }

      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
        if (request.method === "PATCH") {
          return handleUpdateSessionTitle(request, options, allowed, browserGateway, sessionId);
        }
        if (request.method === "DELETE") {
          return handleDeleteSession(
            request,
            options,
            allowed,
            browserGateway,
            scheduler,
            runnerGateway,
            dispatcher,
            sessionId,
          );
        }
      }

      // §11.5: a session's schedules, and cancel-by-id. Both owner-scoped.
      const sessionSchedulesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/schedules$/);
      if (sessionSchedulesMatch && request.method === "GET") {
        return handleListSchedules(
          request,
          options,
          allowed,
          browserGateway,
          decodeURIComponent(sessionSchedulesMatch[1] ?? ""),
        );
      }

      const scheduleMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)$/);
      if (scheduleMatch && request.method === "DELETE") {
        return handleCancelSchedule(
          request,
          options,
          allowed,
          browserGateway,
          decodeURIComponent(scheduleMatch[1] ?? ""),
        );
      }

      // Fetch an attachment by id: browser (owner) and runner endpoints.
      const attachmentGetMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)$/);
      if (attachmentGetMatch && request.method === "GET") {
        return handleGetAttachment(
          request,
          options,
          allowed,
          browserGateway,
          decodeURIComponent(attachmentGetMatch[1] ?? ""),
        );
      }

      const runnerAttachmentMatch = url.pathname.match(/^\/api\/runner\/attachments\/([^/]+)$/);
      if (runnerAttachmentMatch && request.method === "GET") {
        return handleGetRunnerAttachment(
          request,
          options,
          decodeURIComponent(runnerAttachmentMatch[1] ?? ""),
        );
      }

      if (url.pathname === "/api/workspaces" && request.method === "GET") {
        return handleListWorkspaces(request, options, allowed, browserGateway);
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

      const decisionMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
      if (decisionMatch && request.method === "POST") {
        return handleApprovalDecision(
          request,
          options,
          allowed,
          browserGateway,
          dispatcher,
          decodeURIComponent(decisionMatch[1] ?? ""),
        );
      }

      // Read-only inspection (§23 §10). Five routes, one contract: the owner
      // names a workspace through its composite id and the runner's `rpc.result`
      // answers the waiting request. The capture stays encoded here —
      // `parseCompositeId` owns the single decode, so decoding twice would
      // corrupt an id that legitimately contains a `%`.
      const filesMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/files$/);
      if (filesMatch && request.method === "GET") {
        return handleInspect(
          request,
          options,
          allowed,
          browserGateway,
          runnerGateway,
          pending,
          dispatcher,
          filesMatch[1] ?? "",
          "file.list",
        );
      }

      const fileMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/file$/);
      if (fileMatch && request.method === "GET") {
        return handleInspect(
          request,
          options,
          allowed,
          browserGateway,
          runnerGateway,
          pending,
          dispatcher,
          fileMatch[1] ?? "",
          "file.read",
        );
      }

      const changesMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/changes$/);
      if (changesMatch && request.method === "GET") {
        return handleInspect(
          request,
          options,
          allowed,
          browserGateway,
          runnerGateway,
          pending,
          dispatcher,
          changesMatch[1] ?? "",
          "git.changes",
        );
      }

      const diffMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/diff$/);
      if (diffMatch && request.method === "GET") {
        return handleInspect(
          request,
          options,
          allowed,
          browserGateway,
          runnerGateway,
          pending,
          dispatcher,
          diffMatch[1] ?? "",
          "git.diff",
        );
      }

      const diagnosticsMatch = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/config\/diagnostics$/,
      );
      if (diagnosticsMatch && request.method === "GET") {
        return handleInspect(
          request,
          options,
          allowed,
          browserGateway,
          runnerGateway,
          pending,
          dispatcher,
          diagnosticsMatch[1] ?? "",
          "diagnostics",
        );
      }

      // §7.10: the four mutation routes share the inspection spine. They sit
      // beside the read routes so the capture stays encoded — `parseCompositeId`
      // owns the single decode. The PUT file route matches on method too, so it
      // cannot shadow the GET file route.
      const snapshotMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/snapshot$/);
      if (snapshotMatch && request.method === "GET") {
        return handleInspect(
          request,
          options,
          allowed,
          browserGateway,
          runnerGateway,
          pending,
          dispatcher,
          snapshotMatch[1] ?? "",
          "snapshot.status",
        );
      }

      // Workspace session history (§23 Task 8). The composite id stays encoded
      // here — `parseCompositeId` inside the handler owns the single decode, so
      // an id that legitimately contains a `%` round-trips correctly.
      const sessionsListMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/sessions$/);
      if (sessionsListMatch && request.method === "GET") {
        return handleWorkspaceSessionsList(
          request,
          options,
          allowed,
          browserGateway,
          runnerGateway,
          pending,
          dispatcher,
          sessionsListMatch[1] ?? "",
        );
      }

      const sessionMessagesMatch = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)\/messages$/,
      );
      if (sessionMessagesMatch && request.method === "GET") {
        return handleWorkspaceSessionMessages(
          request,
          options,
          allowed,
          browserGateway,
          runnerGateway,
          pending,
          dispatcher,
          sessionMessagesMatch[1] ?? "",
          decodeURIComponent(sessionMessagesMatch[2] ?? ""),
        );
      }

      const writeMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/file$/);
      if (writeMatch && request.method === "PUT") {
        return handleFileWrite(
          request,
          {
            options,
            allowedOrigins: allowed,
            browserGateway,
            runnerGateway,
            pending,
            dispatcher,
            compositeId: writeMatch[1] ?? "",
          },
          url.searchParams.get("path") ?? "",
        );
      }

      const fileRevertMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/file\/revert$/);
      if (fileRevertMatch && request.method === "POST") {
        return handleFileRevert(request, {
          options,
          allowedOrigins: allowed,
          browserGateway,
          runnerGateway,
          pending,
          dispatcher,
          compositeId: fileRevertMatch[1] ?? "",
        });
      }

      const revertMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/revert$/);
      if (revertMatch && request.method === "POST") {
        return handleWorkspaceRevert(request, {
          options,
          allowedOrigins: allowed,
          browserGateway,
          runnerGateway,
          pending,
          dispatcher,
          compositeId: revertMatch[1] ?? "",
        });
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
      // §12.6: bounded inbound payloads, declared before the spread so a
      // handler object returning the key cannot silently override it. Bun
      // refuses an oversized message by closing the socket itself (measured:
      // code 1006, reason "Received too big message") rather than delivering a
      // truncated frame, and it does not expose the configured limit on the
      // server object — so the wiring test asserts the refusal behaviour, not
      // the number.
      maxPayloadLength: WS_MAX_PAYLOAD_BYTES,
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
    stop: () => {
      scheduleLoop.stop();
      server.stop(true);
    },
  };
}

function isBrowserSocket(data: unknown): data is BrowserSocketData {
  return typeof data === "object" && data !== null && "userId" in data;
}
