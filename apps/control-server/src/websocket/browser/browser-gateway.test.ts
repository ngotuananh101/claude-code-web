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

function makeSocket(sendStatus: number | (() => number) = 1) {
  const sent: Array<Record<string, unknown>> = [];
  const closed: number[] = [];
  const socket = {
    data: {
      userId: "",
      authenticated: false,
      subscriptions: new Set<string>(),
    } as BrowserSocketData,
    send(payload: string) {
      // Bun answers 0 when the connection is closed or already over
      // `backpressureLimit`: the frame was dropped, not queued. A socket that
      // records nothing for a dropped send is the honest fake — the delivery
      // never happened.
      const status = typeof sendStatus === "function" ? sendStatus() : sendStatus;
      if (status !== 0) sent.push(JSON.parse(String(payload)) as Record<string, unknown>);
      return status;
    },
    close(code?: number) {
      closed.push(code ?? 1000);
    },
  };
  return { socket, sent, closed };
}

type ReplayHarness = {
  history?: BrowserGatewayOptions["readHistory"];
  owner?: (sessionId: string) => string | undefined;
  events?: BrowserReplayEvent[];
  bounds?: { watermark: number; earliest: number };
};

describe("lazy history bootstrap", () => {
  test("cold subscription uses one history page instead of replaying all events", async () => {
    const { gateway, cookie } = await setup({
      replay: {
        events: Array.from({ length: 500 }, (_, i) => replayEvent(i + 1)),
        history: () => ({
          turns: [],
          before: null,
          hasMore: true,
          resetSequence: 0,
          watermark: 500,
          context: [],
        }),
      },
    });
    const { socket, sent } = makeSocket();
    await gateway.attach(socket, { origin, cookie });
    gateway.handleMessage(
      socket,
      JSON.stringify({
        type: "subscribe",
        sessionId: "session",
        projection: "journal",
        history: true,
      }),
    );
    expect(sent.map((frame) => frame["type"])).toEqual(["subscribed", "session.history"]);
    expect(sent[1]!["watermark"]).toBe(500);
    expect(sent[1]!["bootstrap"]).toBe(true);
  });

  test.each(["foreign", "unknown"])(
    "history errors echo correlation without revealing ownership for %s",
    async (id) => {
      const { gateway, cookie } = await setup({
        replay: { owner: (sessionId) => (sessionId === "foreign" ? "another-owner" : undefined) },
      });
      const { socket, sent } = makeSocket();
      await gateway.attach(socket, { origin, cookie });
      gateway.handleMessage(
        socket,
        JSON.stringify({
          type: "history.before",
          sessionId: id,
          requestId: "older-1",
          before: 10,
          resetSequence: 0,
        }),
      );
      expect(sent).toEqual([
        { type: "error", reason: "forbidden", sessionId: id, requestId: "older-1" },
      ]);
    },
  );

  test("malformed older cursors retain valid bounded correlation fields", async () => {
    const { gateway, cookie } = await setup();
    const { socket, sent } = makeSocket();
    await gateway.attach(socket, { origin, cookie });
    gateway.handleMessage(
      socket,
      JSON.stringify({
        type: "history.before",
        sessionId: "session",
        requestId: "older-2",
        before: -1,
        resetSequence: 0,
      }),
    );
    expect(sent.at(-1)).toEqual({
      type: "error",
      reason: "malformed",
      sessionId: "session",
      requestId: "older-2",
    });
    gateway.handleMessage(
      socket,
      JSON.stringify({
        type: "history.before",
        sessionId: "s".repeat(513),
        requestId: "older-3",
        before: 10,
        resetSequence: 0,
      }),
    );
    expect(sent.at(-1)).toEqual({ type: "error", reason: "malformed", requestId: "older-3" });
  });

  test("a reset-stale older cursor gets an explicit error", async () => {
    const { gateway, cookie } = await setup({
      replay: {
        history: () => {
          throw new Error("history_reset");
        },
      },
    });
    const { socket, sent } = makeSocket();
    await gateway.attach(socket, { origin, cookie });
    gateway.handleMessage(
      socket,
      JSON.stringify({
        type: "history.before",
        sessionId: "session",
        before: 10,
        resetSequence: 0,
      }),
    );
    expect(sent).toEqual([{ type: "error", reason: "history_reset", sessionId: "session" }]);
  });

  test("a dropped subscription acknowledgement never reads the history page", async () => {
    const { gateway, cookie } = await setup({
      replay: {
        history: () => {
          throw new Error("read after dropped send");
        },
      },
    });
    const { socket, closed } = makeSocket(0);
    await gateway.attach(socket, { origin, cookie });
    gateway.handleMessage(
      socket,
      JSON.stringify({
        type: "subscribe",
        sessionId: "session",
        projection: "journal",
        history: true,
      }),
    );
    expect(closed).toEqual([4002]);
  });

  test("older pages require ownership and reject a reset-stale cursor", async () => {
    const { gateway, cookie } = await setup({
      replay: {
        owner: (id) => (id === "foreign" ? "another-owner" : undefined),
        history: () => {
          throw new Error("must not read foreign data");
        },
      },
    });
    const { socket, sent } = makeSocket();
    await gateway.attach(socket, { origin, cookie });
    gateway.handleMessage(
      socket,
      JSON.stringify({
        type: "history.before",
        sessionId: "foreign",
        before: 10,
        resetSequence: 0,
      }),
    );
    expect(sent.at(-1)).toEqual({ type: "error", reason: "forbidden", sessionId: "foreign" });
  });
});

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
    readJournalReplay: (_sessionId, after, through, limit) =>
      events
        .filter(
          (e) =>
            e.sessionSequence > after &&
            e.sessionSequence <= through &&
            !(
              e.type === "run.status" &&
              (e.payload as Record<string, unknown> | null)?.["type"] === "system" &&
              (e.payload as Record<string, unknown>)["subtype"] === "thinking_tokens"
            ),
        )
        .slice(0, limit),
    ...(replay.history === undefined ? {} : { readHistory: replay.history }),
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
    sendStatus: number | (() => number) = 1,
    projection?: "journal",
  ) {
    const made = makeSocket(sendStatus);
    await gateway.attach(made.socket, { origin, cookie });
    made.sent.length = 0;
    gateway.handleMessage(
      made.socket,
      JSON.stringify({
        type: "subscribe",
        sessionId,
        ...(after === undefined ? {} : { afterSessionSequence: after }),
        ...(projection === undefined ? {} : { projection }),
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

  test("one committed ingest batch becomes one live frame per subscribed socket", async () => {
    const { gateway, cookie } = await setup();
    const raw = await subscribe(gateway, cookie, "session-1");
    const journal = await subscribe(gateway, cookie, "session-1", 0, 1, "journal");
    const rawBefore = raw.sent.length;
    const journalBefore = journal.sent.length;
    const progress = replayEvent(2, {
      type: "run.status",
      payload: { type: "system", subtype: "thinking_tokens", estimated_tokens: 2 },
    });

    // One ingest transaction committed three events; the browser socket should
    // pay for one frame, not three — the per-event fan-out was pure overhead
    // because every socket receives the whole batch anyway.
    gateway.publishBatch([
      { sessionId: "session-1", ...replayEvent(1) },
      { sessionId: "session-1", ...progress },
      { sessionId: "session-1", ...replayEvent(3, { type: "run.finished" }) },
    ]);

    expect(raw.sent.length).toBe(rawBefore + 1);
    expect(raw.sent.at(-1)).toMatchObject({ type: "session.events", live: true, through: 3 });
    expect((raw.sent.at(-1)!["events"] as unknown[]).length).toBe(3);

    // The journal projection stays the same contract, just carried once: the
    // range is certified from the batch's first sequence and the omitted
    // telemetry never appears in `events`.
    expect(journal.sent.length).toBe(journalBefore + 1);
    expect(journal.sent.at(-1)).toMatchObject({
      type: "session.events",
      live: true,
      projection: "journal",
      fromSequence: 1,
      through: 3,
      events: [replayEvent(1), replayEvent(3, { type: "run.finished" })],
    });
  });

  test("batch frames never merge sequences that are not contiguous", async () => {
    const { gateway, cookie } = await setup();
    const { sent } = await subscribe(gateway, cookie, "session-1");
    const before = sent.length;

    // A committed batch is normally contiguous, but duplicate replay can leave
    // holes in what was stored. Sending one frame across the hole would make
    // the client's contiguous watermark skip a sequence it never received.
    gateway.publishBatch([
      { sessionId: "session-1", ...replayEvent(1) },
      { sessionId: "session-1", ...replayEvent(2) },
      { sessionId: "session-1", ...replayEvent(5) },
    ]);

    const frames = sent.slice(before);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ through: 2 });
    expect(frames[1]).toMatchObject({ through: 5 });
    expect((frames[1]!["events"] as unknown[]).length).toBe(1);
  });

  test("opt-in journal replay covers omitted telemetry through the committed tail", async () => {
    const progress = (seq: number) =>
      replayEvent(seq, {
        type: "run.status",
        payload: { type: "system", subtype: "thinking_tokens", estimated_tokens: seq },
      });
    const { gateway, cookie } = await setup({
      replay: {
        events: [replayEvent(1), progress(2), progress(3), replayEvent(4), progress(5)],
      },
    });
    const compact = await subscribe(gateway, cookie, "session-1", 0, 1, "journal");
    expect(compact.sent[1]).toEqual({
      type: "session.events",
      sessionId: "session-1",
      live: false,
      projection: "journal",
      fromSequence: 1,
      through: 5,
      replayComplete: true,
      events: [replayEvent(1), replayEvent(4)],
    });
    const raw = await subscribe(gateway, cookie, "session-1");
    expect((raw.sent[1]!["events"] as unknown[]).length).toBe(5);
    const beforeTelemetry = compact.sent.length;
    gateway.publish({ sessionId: "session-1", ...progress(6) });
    // A projected socket is not sent a live frame that carries nothing new:
    // the range it would certify is carried by the next content frame, whose
    // fromSequence reaches back over the omitted telemetry. Raw subscribers
    // still need every event, so they pay for it.
    expect(compact.sent.length).toBe(beforeTelemetry);
    expect(raw.sent.at(-1)!["events"]).toEqual([progress(6)]);
    gateway.publish({ sessionId: "session-1", ...replayEvent(7, { type: "question.requested" }) });
    expect(compact.sent.at(-1)).toMatchObject({
      projection: "journal",
      live: true,
      fromSequence: 6,
      through: 7,
      events: [replayEvent(7, { type: "question.requested" })],
    });
  });

  test("a resubscribe covers held telemetry in its replay, not in the next live frame", async () => {
    const progress = (seq: number) =>
      replayEvent(seq, {
        type: "run.status",
        payload: { type: "system", subtype: "thinking_tokens" },
      });
    const { gateway, cookie } = await setup({
      replay: { events: [progress(1)], bounds: { watermark: 2, earliest: 1 } },
    });
    const { socket, sent } = await subscribe(gateway, cookie, "session-1", 0, 1, "journal");

    // Held while live: no frame carries it yet.
    gateway.publish({ sessionId: "session-1", ...progress(2) });
    expect(sent.filter((frame) => frame["type"] === "session.events")).toHaveLength(1);

    // A repair resubscribe replays through the watermark (2), so the held
    // range is certified there. The next content frame must start at itself,
    // not reach back to a range the replay already covered.
    socket.data.subscriptions.delete("session-1");
    socket.data.subscriptions.add("session-1");
    gateway.handleMessage(
      socket,
      JSON.stringify({ type: "subscribe", sessionId: "session-1", projection: "journal" }),
    );
    expect(sent.at(-1)).toMatchObject({ through: 2, replayComplete: true, events: [] });

    gateway.publish({ sessionId: "session-1", ...replayEvent(3) });
    expect(sent.at(-1)).toMatchObject({ fromSequence: 3, through: 3 });
  });

  test("journal replay finishes on the last content page, not an empty tail frame", async () => {
    // Exactly one full replay page of content, then a telemetry tail. The page
    // boundary alone must not force an empty completion frame: the page reads
    // ahead once, sees no more content, and certifies the whole remaining range
    // itself.
    const content = Array.from({ length: BrowserGateway.REPLAY_BATCH_LIMIT }, (_, i) =>
      replayEvent(i * 2 + 1),
    );
    const tail = replayEvent(content.length * 2, {
      type: "run.status",
      payload: { type: "system", subtype: "thinking_tokens" },
    });
    const { gateway, cookie } = await setup({
      replay: {
        events: [...content, tail],
        bounds: { watermark: tail.sessionSequence, earliest: 1 },
      },
    });

    const { sent } = await subscribe(gateway, cookie, "session-1", 0, 1, "journal");

    const frames = sent.filter((frame) => frame["type"] === "session.events");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      fromSequence: 1,
      through: tail.sessionSequence,
      replayComplete: true,
      events: content,
    });
  });

  test("journal replay still chains when more content follows a full page", async () => {
    const content = Array.from({ length: BrowserGateway.REPLAY_BATCH_LIMIT + 30 }, (_, i) =>
      replayEvent(i + 1),
    );
    const { gateway, cookie } = await setup({ replay: { events: content } });

    const { sent } = await subscribe(gateway, cookie, "session-1", 0, 1, "journal");

    const frames = sent.filter((frame) => frame["type"] === "session.events");
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      fromSequence: 1,
      through: BrowserGateway.REPLAY_BATCH_LIMIT,
      replayComplete: false,
      events: content.slice(0, BrowserGateway.REPLAY_BATCH_LIMIT),
    });
    expect(frames[1]).toMatchObject({
      fromSequence: BrowserGateway.REPLAY_BATCH_LIMIT + 1,
      through: content.length,
      replayComplete: true,
      events: content.slice(BrowserGateway.REPLAY_BATCH_LIMIT),
    });
  });

  test("journal replay absorbs an interleaved telemetry tail into the last content page", async () => {
    // The watermark is 400 and the page is full, but the remaining range is
    // pure telemetry. The page is not followed by an empty completion frame:
    // it reads one row ahead, sees no content, and certifies through 400.
    const content = Array.from({ length: 200 }, (_, i) => replayEvent(i * 2 + 1));
    const progress = Array.from({ length: 200 }, (_, i) =>
      replayEvent(i * 2 + 2, {
        type: "run.status",
        payload: { type: "system", subtype: "thinking_tokens" },
      }),
    );
    const { gateway, cookie } = await setup({
      replay: {
        events: [...content, ...progress].sort((a, b) => a.sessionSequence - b.sessionSequence),
      },
    });
    const { sent } = await subscribe(gateway, cookie, "session-1", 0, 1, "journal");
    const frames = sent.filter((frame) => frame["type"] === "session.events");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      fromSequence: 1,
      through: 400,
      replayComplete: true,
      events: content,
    });
  });

  test("compact subscriptions retain ownership checks and the retention rewind contract", async () => {
    const { gateway, cookie } = await setup({
      replay: {
        events: [replayEvent(4), replayEvent(5)],
        bounds: { watermark: 5, earliest: 4 },
        owner: (sessionId) => (sessionId === "other" ? "someone-else" : undefined),
      },
    });
    const forbidden = await subscribe(gateway, cookie, "other", 0, 1, "journal");
    const unknown = await subscribe(gateway, cookie, "unknown", 0, 1, "journal");
    expect(forbidden.sent).toEqual(unknown.sent);
    expect(forbidden.socket.data.subscriptions.size).toBe(0);

    const owned = await setup({
      replay: {
        events: [replayEvent(4), replayEvent(5)],
        bounds: { watermark: 5, earliest: 4 },
      },
    });
    const { socket, sent } = await subscribe(
      owned.gateway,
      owned.cookie,
      "session-1",
      0,
      1,
      "journal",
    );
    expect(sent[1]).toEqual({
      type: "session.resync_required",
      sessionId: "session-1",
      fromSequence: 4,
    });
    owned.gateway.handleMessage(
      socket,
      JSON.stringify({
        type: "subscribe",
        sessionId: "session-1",
        afterSessionSequence: 3,
        projection: "journal",
      }),
    );
    expect(sent.at(-1)).toMatchObject({ fromSequence: 4, through: 5, replayComplete: true });
  });

  test("journal subscription mode is per session and resets on unsubscribe", async () => {
    const { gateway, cookie } = await setup();
    const { socket, sent } = await subscribe(gateway, cookie, "session-1", 0, 1, "journal");
    expect(sent[1]).toMatchObject({
      fromSequence: 1,
      through: 0,
      replayComplete: true,
      events: [],
    });
    gateway.handleMessage(socket, JSON.stringify({ type: "subscribe", sessionId: "session-2" }));
    const progress = replayEvent(1, {
      type: "run.status",
      payload: { type: "system", subtype: "thinking_tokens" },
    });
    gateway.publish({ sessionId: "session-2", ...progress });
    expect(sent.at(-1)!["events"]).toEqual([progress]);
    gateway.handleMessage(socket, JSON.stringify({ type: "unsubscribe", sessionId: "session-1" }));
    gateway.handleMessage(socket, JSON.stringify({ type: "subscribe", sessionId: "session-1" }));
    gateway.publish({ sessionId: "session-1", ...progress });
    expect(sent.at(-1)!["projection"]).toBeUndefined();
    expect(sent.at(-1)!["events"]).toEqual([progress]);
  });

  test("journal replay resumes content after the cursor and certifies a telemetry-only tail", async () => {
    const { gateway, cookie } = await setup({
      replay: {
        events: [
          replayEvent(1),
          replayEvent(2, {
            type: "run.status",
            payload: { type: "system", subtype: "thinking_tokens" },
          }),
        ],
      },
    });
    const { sent } = await subscribe(gateway, cookie, "session-1", 1, 1, "journal");
    expect(sent[1]).toMatchObject({
      fromSequence: 2,
      through: 2,
      replayComplete: true,
      events: [],
    });
    const ahead = await subscribe(gateway, cookie, "session-1", 9, 1, "journal");
    expect(ahead.sent[1]).toMatchObject({
      fromSequence: 3,
      through: 2,
      replayComplete: true,
      events: [],
    });
  });

  test("a failed subscription send does not read any replay pages", async () => {
    let reads = 0;
    const gateway = new BrowserGateway({
      resolveSession: async () => "owner",
      allowedOrigins: [origin],
      resolveOwner: () => "owner",
      replayBounds: () => ({ watermark: 1000, earliest: 1 }),
      readReplay: () => {
        reads++;
        return [];
      },
    });
    const { socket } = makeSocket(0);
    await gateway.attach(socket, { origin });
    gateway.handleMessage(socket, JSON.stringify({ type: "subscribe", sessionId: "session-1" }));
    expect(reads).toBe(0);
  });

  test("replay stops querying as soon as a page cannot be delivered", async () => {
    let reads = 0;
    let sends = 0;
    const gateway = new BrowserGateway({
      resolveSession: async () => "owner",
      allowedOrigins: [origin],
      resolveOwner: () => "owner",
      replayBounds: () => ({ watermark: 1000, earliest: 1 }),
      readReplay: (_sessionId, after, limit) => {
        reads++;
        return Array.from({ length: after < 1000 ? limit : 0 }, (_, i) =>
          replayEvent(after + i + 1),
        );
      },
    });
    const { socket, closed } = makeSocket(() => (++sends === 1 ? 1 : 0));
    await gateway.attach(socket, { origin });
    gateway.handleMessage(socket, JSON.stringify({ type: "subscribe", sessionId: "session-1" }));
    expect(reads).toBe(1);
    expect(closed).toEqual([4002]);
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

  test("a send Bun reports as dropped disconnects the socket", async () => {
    // Bun answers -1 for "queued under backpressure" and 0 for "dropped"
    // (closed, or past `backpressureLimit`). Reading 0 as success is exactly the
    // silent loss §12.6 forbids: the server would consider the frame delivered
    // while the browser never saw it, and nothing would replay the gap.
    const { gateway, cookie, userId } = await setup({
      replay: { events: [replayEvent(1)] },
    });

    const { socket, sent, closed } = await subscribe(gateway, cookie, "session-1", undefined, 0);

    // The whole subscription happened on a dead link, so nothing was delivered
    // and the socket is closed rather than left registered.
    expect(sent).toHaveLength(0);
    expect(closed).toContain(4002);
    // Dropped from the registry: no later publish pays for this socket again,
    // and the client's own reconnect + replay (§12.5) is the recovery.
    expect(gateway.socketCount(userId)).toBe(0);
    expect(gateway.socketCountForSession("session-1")).toBe(0);
    expect(socket.data.subscriptions.has("session-1")).toBe(true);
  });

  test("a publish that cannot be delivered drops only the socket it failed on", async () => {
    const { gateway, cookie, userId } = await setup();

    // The broken socket subscribes on a link that already refuses frames, so it
    // is gone before the publish happens — the healthy one is what the loop
    // must not lose.
    const broken = await subscribe(gateway, cookie, "session-1", undefined, 0);
    const healthy = await subscribe(gateway, cookie, "session-1");
    expect(gateway.socketCountForSession("session-1")).toBe(1);
    expect(gateway.socketCount(userId)).toBe(1);

    gateway.publish({ sessionId: "session-1", ...replayEvent(1) });

    expect(healthy.sent.at(-1)).toMatchObject({ type: "session.events", live: true });
    expect(broken.sent).toHaveLength(0);
    expect(healthy.closed).toHaveLength(0);
    expect(gateway.socketCount(userId)).toBe(1);
  });

  test("a socket that falls over the send limit during a live publish is closed 4002", async () => {
    const { gateway, cookie, userId } = await setup();

    // Healthy for the subscribe frames, then past `backpressureLimit`: the live
    // frame is dropped, not queued. Reading that drop as a delivery is the
    // silent loss §12.6 forbids, so the socket goes with the backpressure close
    // code and its client replays the gap on reconnect.
    let status = 1;
    const { sent, closed } = await subscribe(gateway, cookie, "session-1", undefined, () => status);
    const delivered = sent.length;

    status = 0;
    gateway.publish({ sessionId: "session-1", ...replayEvent(1) });

    expect(sent).toHaveLength(delivered);
    expect(closed).toContain(4002);
    expect(gateway.socketCount(userId)).toBe(0);
    expect(gateway.socketCountForSession("session-1")).toBe(0);
  });

  test("a send Bun reports as queued under backpressure is not a drop", async () => {
    const { gateway, cookie, userId } = await setup();

    const { closed } = await subscribe(gateway, cookie, "session-1", undefined, -1);

    // -1 is a success: the bytes are buffered and will be written. Closing here
    // would disconnect a browser that is merely behind, which is the opposite
    // of what backpressure handling is for.
    expect(closed).toHaveLength(0);
    expect(gateway.socketCount(userId)).toBe(1);
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
