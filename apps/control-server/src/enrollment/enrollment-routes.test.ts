import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { migrate, verifyRunnerCredential } from "@cc-web/control-db";
import { AuthService } from "../auth/auth-service.ts";
import { createSigner } from "../auth/tokens.ts";
import { createServer, type ServerHandle } from "../server.ts";

/**
 * Runner enrollment over HTTP (§6.1).
 *
 * Two halves, and the split is the security model:
 *
 *  - `POST /api/runner-enrollments` is the **owner** creating a one-time token.
 *    It carries a session cookie, so it needs the Origin allowlist like any
 *    other browser call.
 *  - `POST /api/runner-enroll` is the **runner** redeeming that token. It has no
 *    cookie and no Origin, because it is a CLI on another machine. The token is
 *    the whole credential, which is why it is short-lived, single-use, and sent
 *    in a body rather than a URL.
 *
 * The end-to-end assertion that matters is the last one: a credential issued
 * here must actually authenticate a runner socket.
 */

const secret = new Uint8Array(32).fill(13);
const origin = "https://cc.example.test";

let handle: ServerHandle | undefined;

async function start() {
  const db = new Database(":memory:");
  migrate(db);
  db.query(
    "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("user-1", "owner", "hash", 1, Date.now());

  const auth = new AuthService({ db, signer: createSigner(secret) });

  // The real verifier, backed by the same database the enrollment wrote to.
  handle = createServer({
    db,
    auth,
    allowedOrigins: [origin],
    verifyRunnerCredential: (credential) => {
      const result = verifyRunnerCredential(db, credential);
      return result.ok
        ? { ok: true, runnerId: result.runnerId, ownerId: result.ownerId }
        : { ok: false, reason: "unknown" };
    },
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

async function createEnrollment(url: string, sessionToken: string): Promise<Response> {
  return fetch(`${url}/api/runner-enrollments`, {
    method: "POST",
    headers: { Origin: origin, Cookie: `cc_session=${sessionToken}` },
  });
}

describe("runner enrollment", () => {
  test("the owner mints a one-time token", async () => {
    const { url, token } = await start();

    const response = await createEnrollment(url, token);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(typeof body["token"]).toBe("string");
    expect(String(body["token"]).startsWith("ccr_")).toBe(true);
    expect(typeof body["expiresAt"]).toBe("number");
  });

  test("minting a token requires the session cookie", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/api/runner-enrollments`, {
      method: "POST",
      headers: { Origin: origin },
    });

    expect(response.status).toBe(401);
  });

  test("minting a token requires an allowlisted origin", async () => {
    const { url, token } = await start();

    const response = await fetch(`${url}/api/runner-enrollments`, {
      method: "POST",
      headers: { Origin: "https://evil.example.test", Cookie: `cc_session=${token}` },
    });

    // A token minted for a hostile page is a token the attacker can redeem.
    expect(response.status).toBe(403);
  });

  test("redeeming a token returns a runner id and a credential", async () => {
    const { url, token } = await start();
    const created = (await (await createEnrollment(url, token)).json()) as { token: string };

    const response = await fetch(`${url}/api/runner-enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: created.token }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(typeof body["runnerId"]).toBe("string");
    expect(String(body["credential"]).startsWith("cck_")).toBe(true);
  });

  test("a token can only be redeemed once", async () => {
    const { url, token } = await start();
    const created = (await (await createEnrollment(url, token)).json()) as { token: string };

    const redeem = () =>
      fetch(`${url}/api/runner-enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: created.token }),
      });

    expect((await redeem()).status).toBe(200);
    // The second attempt must not mint a second credential: that would make the
    // token a permanent enrollment credential (§6.1).
    expect((await redeem()).status).toBe(401);
  });

  test("an unknown token is refused without saying why", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/api/runner-enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "ccr_not_a_real_token" }),
    });

    // Same status for unknown, consumed and expired: the endpoint must not
    // become an oracle for which tokens existed.
    expect(response.status).toBe(401);
  });

  test("the credential response is never cached", async () => {
    const { url, token } = await start();
    const created = (await (await createEnrollment(url, token)).json()) as { token: string };

    const response = await fetch(`${url}/api/runner-enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: created.token }),
    });

    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  test("an enrolled credential authenticates a runner socket", async () => {
    const { url, wsUrl, token } = await start();
    const created = (await (await createEnrollment(url, token)).json()) as { token: string };
    const enrolled = (await (
      await fetch(`${url}/api/runner-enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: created.token }),
      })
    ).json()) as { runnerId: string; credential: string };

    const socket = new WebSocket(`${wsUrl}/ws/runner`, {
      headers: { Authorization: `Bearer ${enrolled.credential}` },
    } as never);
    const messages: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => {
      messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("connect failed")));
    });

    socket.send(
      JSON.stringify({
        type: "hello",
        hello: {
          protocolVersion: 1,
          runnerId: enrolled.runnerId,
          bootId: "boot-1",
          runnerVersion: "0.0.0",
          sdkVersion: "0.3.309",
          platform: "linux/x64",
          maxConcurrentRuns: 1,
          activeRuns: [],
          eventOffsets: [],
        },
      }),
    );

    const deadline = Date.now() + 3000;
    while (messages.length === 0 && Date.now() < deadline) await Bun.sleep(10);

    // This is the whole point: what enrollment issued is what the gateway
    // accepts. A mismatch here would be two separate credential formats.
    expect(messages[0]).toMatchObject({ type: "hello.ok" });
    socket.close();
  });

  test("a malformed enroll request is a 400, not a 401", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/api/runner-enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: 42 }),
    });

    // Bad input is the caller's bug; a bad token is an auth failure. Mixing
    // them would make a client-side type error look like a revoked token.
    expect(response.status).toBe(400);
  });
});
