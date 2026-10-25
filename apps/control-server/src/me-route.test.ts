import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { migrate } from "@cc-web/control-db";
import { AuthService } from "./auth/auth-service.ts";
import { createSigner } from "./auth/tokens.ts";
import { createServer, type RunnerCredentialCheck, type ServerHandle } from "./server.ts";

/**
 * The signed-in account's own name over HTTP (§16.2's rail footer). The rail
 * cannot hardcode it: the seeded username is whatever the operator chose.
 *
 * Same rules as every browser route: Origin allowlist first, then the session
 * cookie, `no-store` on the answer because it is identity-bearing (§19.4).
 */

const origin = "https://cc.example.test";

let handle: ServerHandle | undefined;

async function start() {
  const db = new Database(":memory:");
  migrate(db);

  db.query(
    "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("user-1", "ngotuananh2101", "hash", 1, Date.now());

  const auth = new AuthService({ db, signer: createSigner(new Uint8Array(32).fill(11)) });
  handle = createServer({
    db,
    auth,
    allowedOrigins: [origin],
    // No runner connects in these tests; the check only needs to typecheck
    // and refuse — the route under test never reaches it.
    verifyRunnerCredential: (): RunnerCredentialCheck => ({ ok: false, reason: "unknown" }),
  });
  const cookie = `cc_session=${await auth.issueAccessToken("user-1")}`;
  return { db, auth, url: `http://127.0.0.1:${handle.server.port}`, cookie };
}

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

describe("me route", () => {
  test("answers the signed-in username", async () => {
    const { url, cookie } = await start();

    const response = await fetch(`${url}/api/me`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as { username: string };
    expect(body.username).toBe("ngotuananh2101");
  });

  test("refuses a request without a session cookie", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/api/me`, {
      headers: { Origin: origin },
    });
    expect(response.status).toBe(401);
  });

  test("refuses a foreign Origin before reading anything", async () => {
    const { url, cookie } = await start();

    const response = await fetch(`${url}/api/me`, {
      headers: { Origin: "https://evil.example.test", Cookie: cookie },
    });
    expect(response.status).toBe(403);
  });

  test("a revoked session no longer answers", async () => {
    const { db, auth, url, cookie } = await start();

    db.query("UPDATE users SET token_version = token_version + 1 WHERE id = 'user-1'").run();
    const fresh = `cc_session=${await auth.issueAccessToken("user-1")}`;

    const revoked = await fetch(`${url}/api/me`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    expect(revoked.status).toBe(401);

    const renewed = await fetch(`${url}/api/me`, {
      headers: { Origin: origin, Cookie: fresh },
    });
    expect(renewed.status).toBe(200);
  });
});
