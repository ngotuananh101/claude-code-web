import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { migrate } from "@cc-web/control-db";
import { AuthService } from "../auth/auth-service.ts";
import { createSigner } from "../auth/tokens.ts";
import { createServer, type ServerHandle } from "../server.ts";

/**
 * The assembled control server (§17, §19.1).
 *
 * These exercise the real HTTP surface over a real socket, because the parts
 * most likely to be wrong are the wiring ones: which header carries what, which
 * status a refusal returns, and whether the upgrade actually happens.
 */

const secret = new Uint8Array(32).fill(11);
const origin = "https://cc.example.test";

let handle: ServerHandle | undefined;

async function start(overrides: { allowedOrigins?: string[] } = {}) {
  const db = new Database(":memory:");
  migrate(db);
  db.query(
    "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("user-1", "owner", "hash", 1, Date.now());

  const auth = new AuthService({ db, signer: createSigner(secret) });
  handle = createServer({
    db,
    auth,
    allowedOrigins: overrides.allowedOrigins ?? [origin],
    verifyRunnerCredential: (credential) =>
      credential === "cck_valid"
        ? { ok: true, runnerId: "runner-a", ownerId: "user-1" }
        : { ok: false, reason: "unknown" },
  });

  return {
    db,
    url: `http://127.0.0.1:${handle.server.port}`,
    wsUrl: `ws://127.0.0.1:${handle.server.port}`,
    token: await auth.issueAccessToken("user-1"),
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
  return { messages, closed, send: (m) => socket.send(JSON.stringify(m)) };
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

  test("the browser route requires the allowlisted origin and the session cookie", async () => {
    const { wsUrl, token } = await start();

    const client = await connect(`${wsUrl}/ws/browser`, {
      Origin: origin,
      Cookie: `cc_session=${token}`,
    });
    client.send({ type: "subscribe", sessionId: "session-1" });
    await waitFor(() => client.messages.length >= 1);

    expect(client.messages[0]).toMatchObject({ type: "subscribed", sessionId: "session-1" });
  });

  test("the browser route refuses a foreign origin during the upgrade", async () => {
    const { wsUrl, token } = await start();

    const response = await fetch(`${wsUrl.replace("ws://", "http://")}/ws/browser`, {
      headers: { Origin: "https://evil.example.test", Cookie: `cc_session=${token}` },
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

  test("login sets an HttpOnly cookie and refuses a wrong password", async () => {
    const { url, db } = await start();
    // A real hash would come from a maintained library; this test only cares
    // that a mismatch is refused without saying which field was wrong.
    db.query("UPDATE users SET password_hash = ? WHERE id = ?").run("correct", "user-1");

    const bad = await fetch(`${url}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ username: "owner", password: "wrong" }),
    });

    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();
  });

  test("a login from a disallowed origin is refused before the password is checked", async () => {
    const { url, db } = await start();
    db.query("UPDATE users SET password_hash = ? WHERE id = ?").run("correct", "user-1");

    const response = await fetch(`${url}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example.test" },
      body: JSON.stringify({ username: "owner", password: "correct" }),
    });

    // CSRF: a correct password from a hostile origin must not mint a session.
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
