import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { migrate, verifyRunnerCredential } from "@cc-web/control-db";
import { AuthService } from "../auth/auth-service.ts";
import { createSigner } from "../auth/tokens.ts";
import { createServer, type ServerHandle } from "../server.ts";

/**
 * The runner registry over HTTP (§6.1, connector model).
 *
 * The owner mints a connector token on the web (POST), and lists the runners
 * that exist (GET). Two halves, and the split is the security model:
 *
 *  - Both are browser calls: session cookie, Origin allowlist, `no-store` —
 *    the POST response carries a secret that must not land in any cache.
 *  - The minted token is the runner's whole credential: it travels to the
 *    operator once, and only its hash is kept server-side.
 *
 * The end-to-end assertion that matters is the last one: a token minted here
 * must actually authenticate a runner socket.
 */

const origin = "https://cc.example.test";

let handle: ServerHandle | undefined;

async function start() {
  const db = new Database(":memory:");
  migrate(db);

  db.query(
    "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("user-1", "owner", "hash", 1, Date.now());

  const auth = new AuthService({ db, signer: createSigner(new Uint8Array(32).fill(11)) });
  handle = createServer({
    db,
    auth,
    allowedOrigins: [origin],
    verifyRunnerCredential: (credential) => verifyRunnerCredential(db, credential),
  });

  // The exact cookie /auth/login would set: the signed token itself.
  const cookie = `cc_session=${await auth.issueAccessToken("user-1")}`;

  return {
    db,
    url: `http://127.0.0.1:${handle.server.port}`,
    wsUrl: `ws://127.0.0.1:${handle.server.port}`,
    cookie,
  };
}

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

describe("runner registry routes", () => {
  test("the owner mints a connector token", async () => {
    const { url, cookie } = await start();

    const response = await fetch(`${url}/api/runners`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
    });
    const body = (await response.json()) as { runnerId: string; token: string };

    // A UUID: the operator connects with it once, over stdin, and the server
    // never needs it again.
    expect(response.status).toBe(201);
    expect(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.runnerId),
    ).toBe(true);
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.token)).toBe(
      true,
    );
    // A credential response is never cached (§19.4).
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  test("minting requires the session cookie and the allowlist", async () => {
    const { url, cookie } = await start();

    expect(
      (await fetch(`${url}/api/runners`, { method: "POST", headers: { Origin: origin } })).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}/api/runners`, {
          method: "POST",
          headers: { Origin: "https://evil.example.test", Cookie: cookie },
        })
      ).status,
    ).toBe(403);
  });

  test("only the token's hash is stored", async () => {
    const { db, url, cookie } = await start();

    const minted = (await (
      await fetch(`${url}/api/runners`, {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie },
      })
    ).json()) as { token: string };

    const serialized = JSON.stringify(db.prepare("SELECT * FROM runner_credentials").all());
    expect(serialized).not.toContain(minted.token);
  });

  test("the list answers the runners without any secret material", async () => {
    const { url, cookie } = await start();

    await fetch(`${url}/api/runners`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
    });
    await fetch(`${url}/api/runners`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
    });

    const response = await fetch(`${url}/api/runners`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    const body = (await response.json()) as { runners: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.runners).toHaveLength(2);
    for (const runner of body.runners) {
      expect(Object.keys(runner).sort()).toEqual(["createdAt", "revokedAt", "runnerId"]);
    }
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  test("the list is authenticated like every browser route", async () => {
    const { url, cookie } = await start();

    expect((await fetch(`${url}/api/runners`, { headers: { Origin: origin } })).status).toBe(401);
    expect(
      (
        await fetch(`${url}/api/runners`, {
          headers: { Origin: "https://evil.example.test", Cookie: cookie },
        })
      ).status,
    ).toBe(403);
  });

  test("a minted token authenticates a runner socket", async () => {
    const { url, wsUrl, cookie } = await start();
    const minted = (await (
      await fetch(`${url}/api/runners`, {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie },
      })
    ).json()) as { runnerId: string; token: string };

    const socket = new WebSocket(`${wsUrl}/ws/runner`, {
      headers: { Authorization: `Bearer ${minted.token}` },
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
          runnerId: minted.runnerId,
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

    // This is the whole point: what the web minted is what the gateway accepts.
    expect(messages[0]).toMatchObject({ type: "hello.ok" });
    socket.close();
  });
});
