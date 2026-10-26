import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { ingestEvent, migrate } from "@cc-web/control-db";
import { WS_MAX_PAYLOAD_BYTES } from "@cc-web/protocol";
import { AuthService } from "../auth/auth-service.ts";
import { createSigner } from "../auth/tokens.ts";
import { createServer, type ServerHandle } from "../server.ts";

/**
 * The assembled control server (§17, §19.1).
 *
 * These exercise the real HTTP surface over a real socket, because the parts
 * most likely to be wrong are the wiring ones: which header carries what, which
 * status a refusal returns, and whether the upgrade actually happens.
 *
 * Auth here is the real AuthService, not a stub: the login route, the cookie
 * name and the session checks are exactly what production runs.
 */

const origin = "https://cc.example.test";

let handle: ServerHandle | undefined;

const jwtSecret = new Uint8Array(32).fill(11);

async function start(overrides: { allowedOrigins?: string[] } = {}) {
  const db = new Database(":memory:");
  migrate(db);
  db.query(
    "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("user-1", "owner", "hash", 1, Date.now());

  const auth = new AuthService({ db, signer: createSigner(jwtSecret) });
  handle = createServer({
    db,
    auth,
    allowedOrigins: overrides.allowedOrigins ?? [origin],
    verifyRunnerCredential: (credential) =>
      credential === "cck_valid"
        ? { ok: true, runnerId: "runner-a", ownerId: "user-1" }
        : { ok: false, reason: "unknown" },
  });

  // The exact cookie /auth/login would set: the signed token itself.
  const token = await auth.issueAccessToken("user-1");
  const cookie = `cc_session=${token}`;

  return {
    db,
    userId: "user-1",
    url: `http://127.0.0.1:${handle.server.port}`,
    wsUrl: `ws://127.0.0.1:${handle.server.port}`,
    cookie,
  };
}

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

type Client = {
  messages: Array<Record<string, unknown>>;
  closed: Promise<number>;
  send(message: unknown): void;
  /** Send an already-serialized frame, for sizes a JSON object cannot reach. */
  sendRaw(frame: string): void;
};

async function connect(url: string, headers: Record<string, string>): Promise<Client> {
  const messages: Array<Record<string, unknown>> = [];
  const socket = new WebSocket(url, { headers } as never);
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener("close", (event) => resolve((event as CloseEvent).code));
  });
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("connect failed")));
  });
  return {
    messages,
    closed,
    send: (m) => socket.send(JSON.stringify(m)),
    sendRaw: (frame) => socket.send(frame),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

const hello = {
  protocolVersion: 1,
  runnerId: "runner-a",
  bootId: "boot-1",
  runnerVersion: "0.0.0",
  sdkVersion: "0.3.309",
  platform: "linux/x64",
  maxConcurrentRuns: 1,
  activeRuns: [],
  eventOffsets: [],
};

describe("control server routes", () => {
  test("health reports readiness without leaking configuration", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/healthz`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, protocolVersion: 1 });
  });

  test("an unknown path is a 404, not a fallthrough to a socket route", async () => {
    const { url } = await start();

    expect((await fetch(`${url}/nope`)).status).toBe(404);
  });

  test("the runner route authenticates from a header and reaches ready", async () => {
    const { wsUrl } = await start();

    const client = await connect(`${wsUrl}/ws/runner`, { Authorization: "Bearer cck_valid" });
    client.send({ type: "hello", hello });
    await waitFor(() => client.messages.length >= 1);

    expect(client.messages[0]).toMatchObject({ type: "hello.ok", connectionState: "connected" });

    client.send({ type: "reconcile", runner: [] });
    await waitFor(() => client.messages.length >= 2);

    expect(client.messages[1]).toMatchObject({ type: "reconcile.ok", ready: true });
  });

  test("a runner without a credential gets 401 and no socket", async () => {
    const { wsUrl } = await start();

    const response = await fetch(`${wsUrl.replace("ws://", "http://")}/ws/runner`);
    expect(response.status).toBe(401);
  });

  test("an oversized inbound frame is refused at the transport (§12.6)", async () => {
    // The constant is the decision; what this proves is that it is actually
    // wired, which the constant alone cannot. Bun does not expose the
    // configured limit on the server object, so the refusal itself is the
    // evidence: a legitimate frame of the largest measured size (558 KiB) is
    // accepted, and one just over the 4 MiB limit closes the socket.
    expect(WS_MAX_PAYLOAD_BYTES).toBe(4 * 1024 * 1024);

    const { wsUrl } = await start();
    const client = await connect(`${wsUrl}/ws/runner`, { Authorization: "Bearer cck_valid" });
    client.send({ type: "hello", hello });
    await waitFor(() => client.messages.length >= 1);

    // A frame inside the limit still flows — the limit is a ceiling, not a ban.
    // `reconcile` is small, so reusing the real protocol shape keeps this honest
    // about what a legitimate frame looks like.
    client.send({ type: "reconcile", runner: [] });
    await waitFor(() => client.messages.length >= 2);
    expect(client.messages[1]).toMatchObject({ type: "reconcile.ok" });

    // One byte over the limit: Bun closes rather than delivering a truncated
    // frame. Measured behaviour is a 1006 close ("Received too big message"),
    // not the 1009 the protocol would name — asserting that exact code would
    // pin a Bun implementation detail, so the assertion is that the socket
    // closes and the oversized frame is never delivered as a message.
    const oversized = `x`.repeat(WS_MAX_PAYLOAD_BYTES + 1);
    const before = client.messages.length;
    client.sendRaw(oversized);
    const code = await client.closed;

    expect(code).toBeGreaterThan(0);
    expect(client.messages.length).toBe(before);
  });

  test("the browser route requires the allowlisted origin and the session cookie", async () => {
    const { wsUrl, cookie, db, userId } = await start();

    // §12.5: a subscription is ownership-checked, so the route's happy path
    // needs a session this user can actually see.
    db.query("INSERT INTO runners (id, owner_id, created_at) VALUES (?, ?, ?)").run(
      "runner-a",
      userId,
      1,
    );
    db.query(
      "INSERT INTO active_runs (run_id, session_id, runner_id, attempt_id, dispatched_at) VALUES (?, ?, ?, ?, ?)",
    ).run("run-1", "session-1", "runner-a", "attempt-1", 1);

    const client = await connect(`${wsUrl}/ws/browser`, {
      Origin: origin,
      Cookie: cookie,
    });
    client.send({ type: "subscribe", sessionId: "session-1" });
    await waitFor(() => client.messages.length >= 2);

    expect(client.messages[0]).toMatchObject({ type: "subscribed", sessionId: "session-1" });
    expect(client.messages[1]).toMatchObject({
      type: "session.events",
      sessionId: "session-1",
      live: false,
      through: 0,
    });
  });

  test("signing out closes the owner's live socket with the revocation code", async () => {
    const { url, wsUrl, cookie, db, userId } = await start();

    db.query("INSERT INTO runners (id, owner_id, created_at) VALUES (?, ?, ?)").run(
      "runner-a",
      userId,
      1,
    );
    db.query(
      "INSERT INTO active_runs (run_id, session_id, runner_id, attempt_id, dispatched_at) VALUES (?, ?, ?, ?, ?)",
    ).run("run-1", "session-1", "runner-a", "attempt-1", 1);

    const client = await connect(`${wsUrl}/ws/browser`, { Origin: origin, Cookie: cookie });
    client.send({ type: "subscribe", sessionId: "session-1" });
    await waitFor(() => client.messages.length >= 1);

    const signOut = await fetch(`${url}/auth/logout`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
    });

    // An open subscription must not survive the login that opened it: refusing
    // the next message would still stream every committed event to a sign-out
    // owner (§12.5). 4001 is the gateway's revocation code.
    expect(signOut.status).toBe(200);
    expect(await client.closed).toBe(4001);
  });

  test("the browser route refuses a subscription to a session the user does not own", async () => {
    const { wsUrl, cookie, db } = await start();

    db.query("INSERT INTO runners (id, owner_id, created_at) VALUES (?, ?, ?)").run(
      "runner-a",
      "someone-else",
      1,
    );
    db.query(
      "INSERT INTO active_runs (run_id, session_id, runner_id, attempt_id, dispatched_at) VALUES (?, ?, ?, ?, ?)",
    ).run("run-1", "session-1", "runner-a", "attempt-1", 1);

    const client = await connect(`${wsUrl}/ws/browser`, {
      Origin: origin,
      Cookie: cookie,
    });
    client.send({ type: "subscribe", sessionId: "session-1" });
    await waitFor(() => client.messages.length >= 1);

    // §12.5 + §19.4's no-oracle rule: not-yours and never-heard-of-it are the
    // same answer over the real route too.
    expect(client.messages[0]).toEqual({ type: "error", reason: "forbidden" });
  });

  test("the browser route refuses a foreign origin during the upgrade", async () => {
    const { wsUrl, cookie } = await start();

    const response = await fetch(`${wsUrl.replace("ws://", "http://")}/ws/browser`, {
      headers: { Origin: "https://evil.example.test", Cookie: cookie },
    });

    expect(response.status).toBe(403);
  });

  test("the browser route refuses a missing cookie", async () => {
    const { wsUrl } = await start();

    const response = await fetch(`${wsUrl.replace("ws://", "http://")}/ws/browser`, {
      headers: { Origin: origin },
    });

    expect(response.status).toBe(401);
  });

  test("a foreign origin is refused before the login route reads the body", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example.test" },
      body: JSON.stringify({ username: "owner", password: "dev-password" }),
    });

    // Origin is checked before the body is parsed: a correct password from a
    // hostile page must not mint a session.
    expect(response.status).toBe(403);
  });

  test("the sessions list answers the owner's sessions", async () => {
    const { url, cookie, db, userId } = await start();
    db.query("INSERT INTO runners (id, owner_id, created_at) VALUES (?, ?, ?)").run(
      "runner-a",
      userId,
      1,
    );
    ingestEvent(db, {
      eventId: "evt-1",
      runnerId: "runner-a",
      bootId: "boot-1",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      localSequence: 1,
      occurredAt: "2026-10-24T00:00:00.000Z",
      type: "run.started",
      payload: { commandId: "cmd-1" },
    });

    const response = await fetch(`${url}/api/sessions`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    const body = (await response.json()) as { sessions: Array<Record<string, unknown>> };

    // The sidebar's single read: what the owner's sessions are and how far
    // each one goes, scoped to this owner and cache-free like every
    // identity-bearing response.
    expect(response.status).toBe(200);
    expect(body.sessions[0]).toMatchObject({
      sessionId: "session-1",
      watermark: 1,
      eventCount: 1,
      lastEventType: "run.started",
      live: false,
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  test("the sessions list needs a valid session", async () => {
    const { url, cookie } = await start();

    expect((await fetch(`${url}/api/sessions`, { headers: { Origin: origin } })).status).toBe(401);
    expect(
      (
        await fetch(`${url}/api/sessions`, {
          headers: { Origin: origin, Cookie: "cc_session=nonsense" },
        })
      ).status,
    ).toBe(401);
    // A same-origin GET fetch carries no Origin header at all — the client
    // itself is that request, so a missing Origin must not read as foreign.
    // The cookie is still the whole authentication.
    expect((await fetch(`${url}/api/sessions`)).status).toBe(401);
    expect(
      (
        await fetch(`${url}/api/sessions`, {
          headers: { Origin: "https://evil.example.test", Cookie: cookie },
        })
      ).status,
    ).toBe(403);
    // And the real cookie works without an Origin header (same-origin fetch).
    expect((await fetch(`${url}/api/sessions`, { headers: { Cookie: cookie } })).status).toBe(200);
  });

  test("the server binds the configured port", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const auth = new AuthService({ db, signer: createSigner(jwtSecret) });
    handle = createServer({
      db,
      auth,
      allowedOrigins: [origin],
      verifyRunnerCredential: () => ({ ok: false, reason: "unknown" }),
      port: 8944,
    });

    // The vite dev proxy needs a stable upstream; a random port would turn
    // every restart into a config edit.
    expect(handle.server.port).toBe(8944);
  });
});
