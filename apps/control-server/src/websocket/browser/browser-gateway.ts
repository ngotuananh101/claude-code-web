/**
 * Owner-facing WebSocket gateway (§19.1).
 *
 * Two controls guard the upgrade, and both are required:
 *
 *  1. **Origin allowlist.** A browser attaches cookies to cross-site WebSocket
 *     upgrades, so the same-origin policy does not protect this socket. §19.1
 *     says so explicitly, and a missing Origin is refused rather than trusted —
 *     otherwise a non-browser client could opt out of the check.
 *  2. **Session cookie.** Verified through `AuthService`, which reads
 *     `tokenVersion` on every check, so revocation applies to sockets too.
 *
 * Revocation closes live sockets. Refusing the next message would leave an open
 * subscription streaming events to a login that has been revoked.
 */

import type { AuthService } from "../../auth/auth-service.ts";

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

type BrowserGatewayOptions = {
  auth: AuthService;
  allowedOrigins: string[];
  cookieName?: string;
};

const CLOSE_POLICY = 1008;
const CLOSE_REVOKED = 4001;

export class BrowserGateway {
  readonly #auth: AuthService;
  readonly #allowedOrigins: Set<string>;
  readonly #cookieName: string;
  readonly #sockets = new Map<string, Set<BrowserSocket>>();

  constructor(options: BrowserGatewayOptions) {
    this.#auth = options.auth;
    this.#allowedOrigins = new Set(options.allowedOrigins);
    this.#cookieName = options.cookieName ?? "cc_session";
  }

  async authorize(input: AuthorizeInput): Promise<BrowserAuthorizeResult> {
    // Order matters: the Origin check runs first so a foreign page learns
    // nothing about whether the cookie it caused the browser to send is valid.
    if (!input.origin || !this.#allowedOrigins.has(input.origin)) {
      return { ok: false, reason: "origin_not_allowed" };
    }

    const token = readCookie(input.cookie, this.#cookieName);
    const auth = await this.#auth.authenticate(token);
    if (!auth.ok) {
      return { ok: false, reason: "unauthenticated" };
    }

    return { ok: true, userId: auth.userId };
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

    const sockets = this.#sockets.get(result.userId) ?? new Set();
    sockets.add(socket);
    this.#sockets.set(result.userId, sockets);

    return result;
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
        if (typeof sessionId !== "string" || sessionId === "") {
          this.#send(socket, { type: "error", reason: "malformed" });
          return;
        }
        socket.data.subscriptions.add(sessionId);
        this.#send(socket, { type: "subscribed", sessionId });
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

  handleClose(socket: BrowserSocket): void {
    if (!socket.data.authenticated) return;
    const sockets = this.#sockets.get(socket.data.userId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.#sockets.delete(socket.data.userId);
  }

  /**
   * Tear down every socket for this user. Called after `tokenVersion` is bumped:
   * an open subscription would otherwise keep delivering events to a login that
   * is no longer valid.
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

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;

  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    return decodeURIComponent(trimmed.slice(eq + 1));
  }
  return undefined;
}
