import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "@cc-web/control-db";
import type { BrowserReplayEvent } from "@cc-web/protocol";
import { AuthService } from "../../auth/auth-service.ts";
import { createSigner } from "../../auth/tokens.ts";
import {
  BrowserGateway,
  type BrowserGatewayOptions,
  type BrowserSocketData,
} from "./browser-gateway.ts";

/**
 * The owner-facing WebSocket (§19.1, §12.5).
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
 *
 * On top of the upgrade, a subscription is ownership-checked (§12.5): the
 * journal only streams to the session's owner, and "not yours" and "no such
 * session" answer identically so the socket is not an existence oracle.
 */

const origin = "https://cc.example.test";

function makeSocket() {
  const sent: Array<Record<string, unknown>> = [];
  const closed: number[] = [];
  const socket = {
    data: {
      userId: "",
      authenticated: false,
      subscriptions: new Set<string>(),
    } as BrowserSocketData,
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

type ReplayHarness = {
  owner?: (sessionId: string) => string | undefined;
  events?: BrowserReplayEvent[];
  bounds?: { watermark: number; earliest: number };
};

function replayEvent(
  sessionSequence: number,
  overrides: Partial<BrowserReplayEvent> = {},
): BrowserReplayEvent {
  return {
    sessionSequence,
    eventId: `evt-${sessionSequence}`,
    runId: "run-1",
    attemptId: "attempt-1",
    occurredAt: "2026-10-24T00:00:00.000Z",
    type: "message.delta",
    payload: { n: sessionSequence },
    ...overrides,
  };
}

const jwtSecret = new Uint8Array(32).fill(11);

async function setup(overrides: { allowedOrigins?: string[]; replay?: ReplayHarness } = {}) {
  const db = new Database(":memory:");
  migrate(db);

  const auth = new AuthService({ db, signer: createSigner(jwtSecret) });
  const userId = crypto.randomUUID();
  db.query(
    "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, 1, ?)",
  ).run(userId, "owner", "hash", Date.now());

  const replay = overrides.replay ?? {};
  const events = replay.events ?? [];
  const bounds = replay.bounds ?? {
    watermark: events.length,
    earliest: events.length > 0 ? events[0]!.sessionSequence : 0,
  };

  const gatewayOptions: BrowserGatewayOptions = {
    // The same seam the server wires: cookie header -> live-session answer.
    resolveSession: async (cookie) => {
      const token = cookie
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("cc_session="))
        ?.slice("cc_session=".length);
      const result = await auth.authenticate(token);
      return result.ok ? result.userId : null;
    },
    allowedOrigins: overrides.allowedOrigins ?? [origin],
    // §12.5 defaults: this user owns everything the tests subscribe to, unless
    // a test says otherwise.
    resolveOwner: replay.owner ?? (() => userId),
    readReplay: (_sessionId, after, limit) =>
      events.filter((e) => e.sessionSequence > after).slice(0, limit),
    replayBounds: () => bounds,
  };

  const gateway = new BrowserGateway(gatewayOptions);

  // The exact cookie /auth/login would set: the signed token itself.
  const token = await auth.issueAccessToken(userId);
  const cookie = `cc_session=${token}`;

  return { db, gateway, auth, cookie, userId };
}

describe("browser gateway", () => {
  test("an allowed origin with a valid cookie is accepted", async () => {
    const { gateway, cookie } = await setup();

    const result = await gateway.authorize({ origin, cookie });

    expect(result).toEqual({ ok: true, userId: expect.any(String) });
  });

  test("a foreign origin is refused even with a valid cookie", async () => {
    const { gateway, cookie } = await setup();

    // This is the CSRF case for WebSockets: the browser would happily attach the
    // cookie to a page on another site.
    const result = await gateway.authorize({
      origin: "https://evil.example.test",
      cookie,
    });

    expect(result).toEqual({ ok: false, reason: "origin_not_allowed" });
  });

  test("a missing origin is a same-origin fetch: the cookie still decides", async () => {
    const { gateway, cookie } = await setup();

    // A same-origin GET fetch never carries an Origin header, and authorize
    // now also serves those (GET /api/sessions). Missing Origin passes the
    // origin gate; the cookie remains the whole authentication. The WS
    // upgrade route keeps its own mandatory allowlist check before calling
    // authorize, so a non-browser handshake is still refused there (§19.1).
    const sameOrigin = await gateway.authorize({ cookie });
    expect(sameOrigin.ok).toBe(true);

    const noCookie = await gateway.authorize({});
    expect(noCookie).toEqual({ ok: false, reason: "unauthenticated" });
  });

  test("an allowed origin without a cookie is refused", async () => {
    const { gateway } = await setup();

    const result = await gateway.authorize({ origin });

    expect(result).toEqual({ ok: false, reason: "unauthenticated" });
  });

  test("a revoked token cannot open a socket", async () => {
    const { db, gateway, cookie } = await setup();

    // The tokenVersion bump is what sign-out does (ADR-0001): every check
    // compares the token against the row, so the bump kills this cookie for
    // the very next call.
    db.query("UPDATE users SET token_version = token_version + 1").run();

    const result = await gateway.authorize({ origin, cookie });

    expect(result).toEqual({ ok: false, reason: "unauthenticated" });
  });

  test("the session cookie is picked out of a realistic Cookie header", async () => {
    const { gateway, cookie } = await setup();

    const result = await gateway.authorize({
      origin,
      cookie: `theme=dark; ${cookie}; other=1`,
    });

    expect(result.ok).toBe(true);
  });

  test("a subscription is scoped to the authenticated user and their session", async () => {
    const { gateway, cookie, userId } = await setup();
    const { socket, sent } = makeSocket();
    await gateway.attach(socket, { origin, cookie });

    gateway.handleMessage(socket, JSON.stringify({ type: "subscribe", sessionId: "session-1" }));

    expect(sent[0]).toMatchObject({ type: "subscribed", sessionId: "session-1" });
    expect(socket.data.userId).toBe(userId);
  });

  test("a revoked user's socket is closed when revocation happens", async () => {
    const { gateway, cookie } = await setup();
    const { socket, closed, sent } = makeSocket();
    await gateway.attach(socket, { origin, cookie });

    gateway.revoke(socket.data.userId);

    // The socket must be torn down, not merely refused on its next message:
    // an open subscription keeps streaming events until it is closed.
    expect(closed).toEqual([4001]);
    expect(sent.at(-1)).toMatchObject({ type: "error", reason: "revoked" });
  });

  test("messages before authorization are refused", () => {
    const gateway = new BrowserGateway({
      resolveSession: async () => "user-1",
      allowedOrigins: [origin],
      resolveOwner: () => undefined,
      readReplay: () => [],
      replayBounds: () => ({ watermark: 0, earliest: 0 }),
    });
    const { socket, closed } = makeSocket();

    gateway.handleMessage(socket, JSON.stringify({ type: "subscribe", sessionId: "s" }));

    expect(closed).toEqual([1008]);
  });

  test("an unknown message type is refused, not ignored", async () => {
    const { gateway, cookie } = await setup();
    const { socket, sent } = makeSocket();
    await gateway.attach(socket, { origin, cookie });

    gateway.handleMessage(socket, JSON.stringify({ type: "exfiltrate" }));

    expect(sent[0]).toMatchObject({ type: "error", reason: "unknown_message" });
  });
});

describe("session subscription and replay", () => {
  async function subscribe(
    gateway: BrowserGateway,
    cookie: string,
    sessionId: string,
    after?: number,
  ) {
    const made = makeSocket();
    await gateway.attach(made.socket, { origin, cookie });
    made.sent.length = 0;
    gateway.handleMessage(
      made.socket,
      JSON.stringify({
        type: "subscribe",
        sessionId,
        ...(after === undefined ? {} : { afterSessionSequence: after }),
      }),
    );
    return made;
  }

  test("a subscription replays committed history after the offset, then goes live", async () => {
    const { gateway, cookie } = await setup({
      replay: {
        events: [replayEvent(1), replayEvent(2), replayEvent(3, { type: "run.finished" })],
      },
    });

    const { socket, sent } = await subscribe(gateway, cookie, "session-1");

    expect(sent).toEqual([
      { type: "subscribed", sessionId: "session-1" },
      {
        type: "session.events",
        sessionId: "session-1",
        live: false,
        through: 3,
        events: [
          expect.objectContaining({ sessionSequence: 1, type: "message.delta" }),
          expect.objectContaining({ sessionSequence: 2 }),
          expect.objectContaining({ sessionSequence: 3, type: "run.finished" }),
        ],
      },
    ]);

    // The tail is live: a committed event arrives as it happens, marked so the
    // client can distinguish catch-up from presence.
    gateway.publish({
      sessionId: "session-1",
      ...replayEvent(4, { type: "run.finished" }),
    });
    expect(sent.at(-1)).toMatchObject({
      type: "session.events",
      live: true,
      through: 4,
    });
    expect(socket.data.subscriptions.has("session-1")).toBe(true);
  });

  test("replay resumes from afterSessionSequence, not from zero", async () => {
    const { gateway, cookie } = await setup({
      replay: { events: [replayEvent(1), replayEvent(2), replayEvent(3)] },
    });

    const { sent } = await subscribe(gateway, cookie, "session-1", 2);

    expect(sent[1]).toMatchObject({
      type: "session.events",
      through: 3,
      events: [expect.objectContaining({ sessionSequence: 3 })],
    });
  });

  test("a session the user does not own is refused identically to an unknown one", async () => {
    // §19.4's no-oracle rule applied to sessions: "someone else's" and "never
    // heard of it" must be the same answer, or the socket tells a probe which
    // session ids exist.
    const { gateway, cookie } = await setup({
      replay: {
        owner: (sessionId) => (sessionId === "someone-elses" ? "owner-2" : undefined),
      },
    });

    const refused = await subscribe(gateway, cookie, "someone-elses");
    const unknown = await subscribe(gateway, cookie, "session-ghost");

    expect(refused.sent).toEqual([{ type: "error", reason: "forbidden" }]);
    expect(unknown.sent).toEqual([{ type: "error", reason: "forbidden" }]);
    expect(refused.socket.data.subscriptions.size).toBe(0);

    // Neither refusal left a subscription: a later publish reaches nobody.
    gateway.publish({ sessionId: "someone-elses", ...replayEvent(1) });
    expect(refused.sent).toHaveLength(1);
  });

  test("a retention gap answers resync_required but keeps the tail live", async () => {
    const { gateway, cookie } = await setup({
      replay: {
        events: [replayEvent(4), replayEvent(5)],
        bounds: { watermark: 5, earliest: 4 },
      },
    });

    const { sent } = await subscribe(gateway, cookie, "session-1", 0);

    // The client asked from 0; the journal can serve from 4. Serving the tail
    // silently would look like the session began mid-run.
    expect(sent[1]).toEqual({
      type: "session.resync_required",
      sessionId: "session-1",
      fromSequence: 4,
    });

    gateway.publish({ sessionId: "session-1", ...replayEvent(6) });
    expect(sent.at(-1)).toMatchObject({ type: "session.events", live: true, through: 6 });
  });

  test("an offset at or beyond the watermark gets an honest empty frame", async () => {
    const { gateway, cookie } = await setup({
      replay: { events: [replayEvent(1)], bounds: { watermark: 1, earliest: 1 } },
    });

    const { sent } = await subscribe(gateway, cookie, "session-1", 9);

    // through carries the journal's truth (1), not the client's claim (9): the
    // client's own gap detection decides what to do about being ahead.
    expect(sent[1]).toEqual({
      type: "session.events",
      sessionId: "session-1",
      live: false,
      through: 1,
      events: [],
    });
  });

  test("replay frames are bounded and chained", async () => {
    const many = Array.from({ length: BrowserGateway.REPLAY_BATCH_LIMIT + 5 }, (_, i) =>
      replayEvent(i + 1),
    );
    const { gateway, cookie } = await setup({
      replay: { events: many, bounds: { watermark: many.length, earliest: 1 } },
    });

    const { sent } = await subscribe(gateway, cookie, "session-1", 0);

    // §12.6: bounded frames on a browser socket. A full batch promises another
    // frame; a short one ends the replay.
    const frames = sent.filter((f) => f["type"] === "session.events");
    expect(frames).toHaveLength(2);
    expect((frames[0]!["events"] as unknown[]).length).toBe(BrowserGateway.REPLAY_BATCH_LIMIT);
    expect((frames[1]!["events"] as unknown[]).length).toBe(5);
    expect(frames[1]!["through"]).toBe(many.length);
  });

  test("a malformed offset is refused rather than coerced", async () => {
    const { gateway, cookie } = await setup();

    for (const bad of [-1, 1.5, "3", null]) {
      const { sent, socket } = await subscribe(gateway, cookie, "session-1", bad as number);
      expect(sent).toEqual([{ type: "error", reason: "malformed" }]);
      expect(socket.data.subscriptions.size).toBe(0);
    }
  });

  test("live events reach every subscribed socket and only those", async () => {
    const { gateway, cookie } = await setup();

    const tabA = await subscribe(gateway, cookie, "session-1");
    const tabB = await subscribe(gateway, cookie, "session-1");
    const other = await subscribe(gateway, cookie, "session-2");

    gateway.publish({ sessionId: "session-1", ...replayEvent(1) });

    // §12.5: tabs are observers. Both see the same delivery; the unrelated
    // subscription sees nothing new (its own two subscribe frames only).
    expect(tabA.sent.at(-1)).toMatchObject({ type: "session.events", through: 1 });
    expect(tabB.sent.at(-1)).toMatchObject({ type: "session.events", through: 1 });
    expect(other.sent).toHaveLength(2);

    gateway.handleMessage(
      tabB.socket,
      JSON.stringify({ type: "unsubscribe", sessionId: "session-1" }),
    );
    gateway.publish({ sessionId: "session-1", ...replayEvent(2) });
    expect(tabA.sent.at(-1)).toMatchObject({ through: 2 });
    expect(tabB.sent).toHaveLength(4); // subscribe, empty replay, live 1, unsubscribed — no live 2
  });
});
