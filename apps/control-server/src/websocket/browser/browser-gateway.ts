/**
 * Owner-facing WebSocket gateway (§19.1, §12.5).
 *
 * Two controls guard the upgrade, and both are required:
 *
 *  1. **Origin allowlist.** A browser attaches cookies to cross-site WebSocket
 *     upgrades, so the same-origin policy does not protect this socket. §19.1
 *     says so explicitly, and a missing Origin is refused rather than trusted —
 *     otherwise a non-browser client could opt out of the check.
 *  2. **Session cookie.** Verified through the injected `resolveSession`, which
 *     delegates to better-auth; the gateway never sees cookie names or tokens,
 *     only "this header belongs to user X". Sessions are read from the table on
 *     every check, so revocation applies to sockets too.
 *
 * A third control guards the subscription itself (§12.5): ownership. The
 * journal only replays to the session's owner, and "not yours" answers exactly
 * like "never heard of it", so the socket cannot be used to probe which
 * session ids exist.
 *
 * Revocation closes live sockets. Refusing the next message would leave an open
 * subscription streaming events to a login that has been revoked.
 */

import type { BrowserReplayEvent } from "@cc-web/protocol";
import type { SessionResolver } from "../../auth/better-auth.ts";

export type BrowserSocketData = {
  userId: string;
  authenticated: boolean;
  subscriptions: Set<string>;
};

export type BrowserSocket = {
  readonly data: BrowserSocketData;
  send(payload: string): unknown;
  close(code?: number): unknown;
};

export type AuthorizeInput = {
  origin?: string | undefined;
  cookie?: string | undefined;
};

export type BrowserAuthorizeResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "origin_not_allowed" | "unauthenticated" };

export type BrowserGatewayOptions = {
  /** Resolves a raw Cookie header to a user id, or null when unauthenticated. */
  resolveSession: SessionResolver;
  allowedOrigins: string[];
  /** §12.5: whose session is this? Undefined = unknown; both it and "someone
   * else's" must answer the subscription identically. */
  resolveOwner: (sessionId: string) => string | undefined;
  /** Committed history for replay, in session order, bounded by `limit`. */
  readReplay: (sessionId: string, after: number, limit: number) => BrowserReplayEvent[];
  /** The highest committed sequence and the lowest surviving one. */
  replayBounds: (sessionId: string) => { watermark: number; earliest: number };
};

const CLOSE_POLICY = 1008;
const CLOSE_REVOKED = 4001;

export class BrowserGateway {
  static readonly REPLAY_BATCH_LIMIT = 200;

  readonly #options: BrowserGatewayOptions;
  readonly #resolveSession: SessionResolver;
  readonly #allowedOrigins: Set<string>;
  readonly #sockets = new Map<string, Set<BrowserSocket>>();

  constructor(options: BrowserGatewayOptions) {
    this.#options = options;
    this.#resolveSession = options.resolveSession;
    this.#allowedOrigins = new Set(options.allowedOrigins);
  }

  async authorize(input: AuthorizeInput): Promise<BrowserAuthorizeResult> {
    // Order matters: the Origin check runs first so a foreign page learns
    // nothing about whether the cookie it caused the browser to send is valid.
    // A missing Origin is a same-origin GET fetch — browsers send no Origin
    // header on those, and authorize now also serves such reads — so it passes
    // the gate and the cookie decides. The WS upgrade route checks the
    // allowlist itself before calling authorize (§19.1).
    if (input.origin !== undefined && !this.#allowedOrigins.has(input.origin)) {
      return { ok: false, reason: "origin_not_allowed" };
    }

    const userId = await this.#resolveSession(input.cookie);
    if (userId === null) {
      return { ok: false, reason: "unauthenticated" };
    }

    return { ok: true, userId };
  }

  /** Authorize and register a socket, so revocation can reach it later. */
  async attach(socket: BrowserSocket, input: AuthorizeInput): Promise<BrowserAuthorizeResult> {
    const result = await this.authorize(input);
    if (!result.ok) {
      this.#reject(
        socket,
        result.reason === "origin_not_allowed" ? "origin_not_allowed" : "unauthorized",
        CLOSE_POLICY,
      );
      return result;
    }

    socket.data.userId = result.userId;
    socket.data.authenticated = true;
    this.register(socket);
    return result;
  }

  /**
   * Register a socket the upgrade already authorized. The browser route
   * authorizes before `srv.upgrade` (§19.1), so by `open` the cookie and origin
   * have been checked — but an unregistered socket would be invisible to
   * `publish` and `revoke`, which address sockets through this registry.
   */
  register(socket: BrowserSocket): void {
    const sockets = this.#sockets.get(socket.data.userId) ?? new Set();
    sockets.add(socket);
    this.#sockets.set(socket.data.userId, sockets);
  }

  handleMessage(socket: BrowserSocket, raw: string | Uint8Array): void {
    if (!socket.data.authenticated) {
      this.#reject(socket, "unauthorized", CLOSE_POLICY);
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      this.#reject(socket, "malformed", 1003);
      return;
    }

    if (typeof message !== "object" || message === null) {
      this.#reject(socket, "malformed", 1003);
      return;
    }

    const record = message as Record<string, unknown>;

    switch (record["type"]) {
      case "subscribe": {
        const sessionId = record["sessionId"];
        const after = record["afterSessionSequence"];
        if (
          typeof sessionId !== "string" ||
          sessionId === "" ||
          (after !== undefined &&
            (typeof after !== "number" || !Number.isInteger(after) || after < 0))
        ) {
          this.#send(socket, { type: "error", reason: "malformed" });
          return;
        }

        // §12.5: the journal only streams to the session's owner. Unknown and
        // not-yours answer identically — a difference would turn subscriptions
        // into an oracle for which session ids exist.
        const owner = this.#options.resolveOwner(sessionId);
        if (owner === undefined || owner !== socket.data.userId) {
          this.#send(socket, { type: "error", reason: "forbidden" });
          return;
        }

        // Registered before anything is read: an event committing while this
        // subscription is being set up either happened before the bounds read
        // (so it is in the replay) or after registration (so its live push
        // finds the subscriber). There is no window between the two.
        socket.data.subscriptions.add(sessionId);
        this.#send(socket, { type: "subscribed", sessionId });

        const offset = after ?? 0;
        const { watermark, earliest } = this.#options.replayBounds(sessionId);

        // §12.5: the offset points into history retention has deleted. Serving
        // the surviving tail silently would present a session that appears to
        // begin mid-run, so the client is told to resynchronize instead.
        if (offset + 1 < earliest) {
          this.#send(socket, {
            type: "session.resync_required",
            sessionId,
            fromSequence: earliest,
          });
          return;
        }

        // Bounded frames, chained until a short one (§12.6). An empty final
        // frame is honest about the journal's tail rather than the client's
        // claim: `through` is what the server can vouch for.
        let cursor = offset;
        for (;;) {
          const batch = this.#options.readReplay(
            sessionId,
            cursor,
            BrowserGateway.REPLAY_BATCH_LIMIT,
          );
          const through = batch.length > 0 ? batch[batch.length - 1]!.sessionSequence : watermark;
          this.#send(socket, {
            type: "session.events",
            sessionId,
            live: false,
            through,
            events: batch,
          });
          if (batch.length < BrowserGateway.REPLAY_BATCH_LIMIT) break;
          cursor = through;
        }
        return;
      }

      case "unsubscribe": {
        const sessionId = record["sessionId"];
        if (typeof sessionId === "string") socket.data.subscriptions.delete(sessionId);
        this.#send(socket, { type: "unsubscribed", sessionId });
        return;
      }

      default:
        // Refused rather than ignored: a silently dropped message looks to the
        // client like a subscription that is working.
        this.#send(socket, { type: "error", reason: "unknown_message" });
    }
  }

  /**
   * Push one committed event to every socket subscribed to its session (§12.5).
   *
   * Called after the ingest transaction commits, so what arrives here is
   * already durable: a failed broadcast costs a live frame, never an event —
   * the browser replays the gap from the journal on its next subscribe.
   */
  publish(event: { sessionId: string } & BrowserReplayEvent): void {
    const frame = {
      type: "session.events",
      sessionId: event.sessionId,
      live: true,
      through: event.sessionSequence,
      events: [
        {
          sessionSequence: event.sessionSequence,
          eventId: event.eventId,
          runId: event.runId,
          attemptId: event.attemptId,
          occurredAt: event.occurredAt,
          type: event.type,
          payload: event.payload,
        },
      ],
    };

    for (const sockets of this.#sockets.values()) {
      for (const socket of sockets) {
        if (socket.data.subscriptions.has(event.sessionId)) this.#send(socket, frame);
      }
    }
  }

  handleClose(socket: BrowserSocket): void {
    if (!socket.data.authenticated) return;
    const sockets = this.#sockets.get(socket.data.userId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.#sockets.delete(socket.data.userId);
  }

  /**
   * Tear down every socket for this user. Called when the user's session is
   * deleted (sign-out): an open subscription would otherwise keep delivering
   * events to a login that is no longer valid.
   */
  revoke(userId: string): void {
    const sockets = this.#sockets.get(userId);
    if (!sockets) return;

    for (const socket of sockets) {
      this.#reject(socket, "revoked", CLOSE_REVOKED);
    }
    this.#sockets.delete(userId);
  }

  socketCount(userId: string): number {
    return this.#sockets.get(userId)?.size ?? 0;
  }

  #reject(socket: BrowserSocket, reason: string, code: number): void {
    try {
      socket.send(JSON.stringify({ type: "error", reason }));
    } catch {
      // Already gone; the close below is what matters.
    }
    try {
      socket.close(code);
    } catch {
      // Idempotent from the caller's point of view.
    }
  }

  #send(socket: BrowserSocket, payload: Record<string, unknown>): void {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // A failed send surfaces as a close.
    }
  }
}
