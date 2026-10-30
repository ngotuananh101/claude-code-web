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
      // `models` is the one non-registry field: an offline runner advertises
      // none, which the composer reads as "unknown" and fills from its fallback.
      expect(Object.keys(runner).sort()).toEqual(["createdAt", "models", "revokedAt", "runnerId"]);
      expect(runner["models"]).toEqual([]);
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

  test("revoking a runner kills its credential, durably", async () => {
    // §17: "Revoke credential/dispatch". The token was the runner's whole
    // identity, so revoking has to reach the credential — a runner that
    // reconnects with the same token must be refused, not just disconnected.
    const { db, url, cookie } = await start();
    const minted = (await (
      await fetch(`${url}/api/runners`, {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie },
      })
    ).json()) as { runnerId: string; token: string };

    expect(verifyRunnerCredential(db, minted.token).ok).toBe(true);

    const response = await fetch(`${url}/api/runners/${minted.runnerId}/revoke`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");

    const after = verifyRunnerCredential(db, minted.token);
    expect(after.ok).toBe(false);
    expect(after.ok === false && after.reason).toBe("revoked");
  });

  test("revoking needs the session cookie and the allowlist", async () => {
    const { url, cookie } = await start();
    const minted = (await (
      await fetch(`${url}/api/runners`, {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie },
      })
    ).json()) as { runnerId: string };

    const path = `${url}/api/runners/${minted.runnerId}/revoke`;
    expect((await fetch(path, { method: "POST", headers: { Origin: origin } })).status).toBe(401);
    expect(
      (
        await fetch(path, {
          method: "POST",
          headers: { Origin: "https://evil.example.test", Cookie: cookie },
        })
      ).status,
    ).toBe(403);
  });

  test("revoking answers 404 for a runner the owner does not hold", async () => {
    // The `WHERE owner_id` in revokeRunner makes a foreign id indistinguishable
    // from a missing one — no oracle for whether another owner's runner exists.
    const { url, cookie } = await start();

    const response = await fetch(`${url}/api/runners/does-not-exist/revoke`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
    });
    expect(response.status).toBe(404);
  });

  test("a revoked runner's token cannot authenticate a socket", async () => {
    const { url, wsUrl, cookie } = await start();
    const minted = (await (
      await fetch(`${url}/api/runners`, {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie },
      })
    ).json()) as { runnerId: string; token: string };

    await fetch(`${url}/api/runners/${minted.runnerId}/revoke`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
    });

    const socket = new WebSocket(`${wsUrl}/ws/runner`, {
      headers: { Authorization: `Bearer ${minted.token}` },
    } as never);
    const closed = await new Promise<boolean>((resolve) => {
      socket.addEventListener("close", () => resolve(true));
      socket.addEventListener("open", () => socket.send('{"type":"hello"}'));
      socket.addEventListener("error", () => resolve(true));
      setTimeout(() => resolve(false), 2000);
    });
    expect(closed).toBe(true);
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

  test("the list carries a live runner's advertised models", async () => {
    // The composer's picker is built from this endpoint (§5.2), so a runner's
    // own Claude Code lineup — custom names included — has to survive the hop
    // from its hello into the listing.
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

    const advertised = [
      {
        value: "pro",
        displayName: "pro",
        description: "Custom Opus model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "max"],
      },
    ];
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
          models: advertised,
        },
      }),
    );

    const deadline = Date.now() + 3000;
    while (messages.length === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(messages[0]).toMatchObject({ type: "hello.ok" });

    const body = (await (
      await fetch(`${url}/api/runners`, { headers: { Origin: origin, Cookie: cookie } })
    ).json()) as { runners: Array<{ runnerId: string; models: unknown }> };

    expect(body.runners[0]?.models).toEqual(advertised);
    socket.close();
  });

  test("PATCH /api/runners/:id renames the runner", async () => {
    const { url, cookie } = await start();
    const minted = (await (
      await fetch(`${url}/api/runners`, {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie },
      })
    ).json()) as { runnerId: string };

    const response = await fetch(`${url}/api/runners/${minted.runnerId}`, {
      method: "PATCH",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Runner Văn Phòng" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      runnerId: minted.runnerId,
      name: "Runner Văn Phòng",
    });

    const listResp = await fetch(`${url}/api/runners`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    const listBody = (await listResp.json()) as {
      runners: Array<{ runnerId: string; name?: string }>;
    };
    expect(listBody.runners[0]?.name).toBe("Runner Văn Phòng");
  });

  test("DELETE /api/runners/:id deletes the runner and cascades sessions", async () => {
    const { db, url, cookie } = await start();
    const minted = (await (
      await fetch(`${url}/api/runners`, {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie },
      })
    ).json()) as { runnerId: string };

    db.query(
      "INSERT INTO sessions (id, owner_id, workspace_id, runner_id, created_at) VALUES ('sess-r', 'user-1', 'default', ?, ?)",
    ).run(minted.runnerId, Date.now());

    const response = await fetch(`${url}/api/runners/${minted.runnerId}`, {
      method: "DELETE",
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      runnerId: minted.runnerId,
      deletedSessions: ["sess-r"],
    });

    const listResp = await fetch(`${url}/api/runners`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    const listBody = (await listResp.json()) as { runners: Array<{ runnerId: string }> };
    expect(listBody.runners).toHaveLength(0);

    const sessionRow = db.query("SELECT id FROM sessions WHERE id = 'sess-r'").get();
    expect(sessionRow).toBeNull();
  });
});
