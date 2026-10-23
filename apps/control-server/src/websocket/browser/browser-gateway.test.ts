import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "@cc-web/control-db";
import { createSigner } from "../../auth/tokens.ts";
import { AuthService } from "../../auth/auth-service.ts";
import { BrowserGateway, type BrowserSocketData } from "./browser-gateway.ts";

/**
 * The owner-facing WebSocket (§19.1).
 *
 * Two independent controls guard the upgrade, and both must hold:
 *
 *  1. the Origin is on the allowlist
 *  2. the session cookie authenticates
 *
 * The Origin check is not redundant with the cookie: a browser attaches cookies
 * to cross-site WebSocket upgrades, so same-origin policy alone does not stop a
 * malicious page from opening a socket with the user's credentials. §19.1 says
 * this explicitly.
 */

const secret = new Uint8Array(32).fill(5);

function makeSocket() {
  const sent: Array<Record<string, unknown>> = [];
  const closed: number[] = [];
  const socket = {
    data: { userId: "", authenticated: false, subscriptions: new Set<string>() } as BrowserSocketData,
    send(payload: string) {
      sent.push(JSON.parse(String(payload)) as Record<string, unknown>);
      return 1;
    },
    close(code?: number) {
      closed.push(code ?? 1000);
    },
  };
  return { socket, sent, closed };
}

async function setup(overrides: { allowedOrigins?: string[] } = {}) {
  const db = new Database(":memory:");
  migrate(db);
  db.query("INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)").run(
    "user-1",
    "owner",
    "hash",
    1,
    Date.now(),
  );

  const auth = new AuthService({ db, signer: createSigner(secret) });
  const gateway = new BrowserGateway({
    auth,
    allowedOrigins: overrides.allowedOrigins ?? ["https://cc.example.test"],
  });

  return { db, auth, gateway, token: await auth.issueAccessToken("user-1") };
}

describe("browser gateway", () => {
  test("an allowed origin with a valid cookie is accepted", async () => {
    const { gateway, token } = await setup();

    const result = await gateway.authorize({
      origin: "https://cc.example.test",
      cookie: `cc_session=${token}`,
    });

    expect(result).toEqual({ ok: true, userId: "user-1" });
  });

  test("a foreign origin is refused even with a valid cookie", async () => {
    const { gateway, token } = await setup();

    // This is the CSRF case for WebSockets: the browser would happily attach the
    // cookie to a page on another site.
    const result = await gateway.authorize({
      origin: "https://evil.example.test",
      cookie: `cc_session=${token}`,
    });

    expect(result).toEqual({ ok: false, reason: "origin_not_allowed" });
  });

  test("a missing origin is refused rather than treated as same-origin", async () => {
    const { gateway, token } = await setup();

    // Non-browser clients can omit Origin entirely. Treating that as trusted
    // would make the allowlist opt-out.
    const result = await gateway.authorize({ cookie: `cc_session=${token}` });

    expect(result).toEqual({ ok: false, reason: "origin_not_allowed" });
  });

  test("an allowed origin without a cookie is refused", async () => {
    const { gateway } = await setup();

    const result = await gateway.authorize({ origin: "https://cc.example.test" });

    expect(result).toEqual({ ok: false, reason: "unauthenticated" });
  });

  test("a revoked session cannot open a socket", async () => {
    const { db, gateway, token } = await setup();
    db.query("UPDATE users SET token_version = token_version + 1 WHERE id = ?").run("user-1");

    // §19.1: revoking a login must invalidate its socket access, not just its
    // HTTP requests.
    const result = await gateway.authorize({
      origin: "https://cc.example.test",
      cookie: `cc_session=${token}`,
    });

    expect(result).toEqual({ ok: false, reason: "unauthenticated" });
  });

  test("the cookie is parsed out of a realistic Cookie header", async () => {
    const { gateway, token } = await setup();

    const result = await gateway.authorize({
      origin: "https://cc.example.test",
      cookie: `theme=dark; cc_session=${token}; other=1`,
    });

    expect(result).toEqual({ ok: true, userId: "user-1" });
  });

  test("a subscription is scoped to the authenticated user", async () => {
    const { gateway, token } = await setup();
    const { socket, sent } = makeSocket();
    await gateway.attach(socket, { origin: "https://cc.example.test", cookie: `cc_session=${token}` });

    gateway.handleMessage(socket, JSON.stringify({ type: "subscribe", sessionId: "session-1" }));

    expect(sent[0]).toMatchObject({ type: "subscribed", sessionId: "session-1" });
    expect(socket.data.userId).toBe("user-1");
  });

  test("a revoked user's socket is closed when revocation happens", async () => {
    const { gateway, token } = await setup();
    const { socket, closed, sent } = makeSocket();
    await gateway.attach(socket, { origin: "https://cc.example.test", cookie: `cc_session=${token}` });

    gateway.revoke("user-1");

    // The socket must be torn down, not merely refused on its next message:
    // an open subscription keeps streaming events until it is closed.
    expect(closed).toEqual([4001]);
    expect(sent.at(-1)).toMatchObject({ type: "error", reason: "revoked" });
  });

  test("messages before authorization are refused", () => {
    const gateway = new BrowserGateway({
      auth: { authenticate: async () => ({ ok: true, userId: "user-1" }) } as never,
      allowedOrigins: ["https://cc.example.test"],
    });
    const { socket, closed } = makeSocket();

    gateway.handleMessage(socket, JSON.stringify({ type: "subscribe", sessionId: "s" }));

    expect(closed).toEqual([1008]);
  });

  test("an unknown message type is refused, not ignored", async () => {
    const { gateway, token } = await setup();
    const { socket, sent } = makeSocket();
    await gateway.attach(socket, { origin: "https://cc.example.test", cookie: `cc_session=${token}` });

    gateway.handleMessage(socket, JSON.stringify({ type: "exfiltrate" }));

    expect(sent[0]).toMatchObject({ type: "error", reason: "unknown_message" });
  });
});
