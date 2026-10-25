import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { ingestEvent, migrate, verifyRunnerCredential } from "@cc-web/control-db";
import { AuthService } from "../auth/auth-service.ts";
import { createSigner } from "../auth/tokens.ts";
import { createServer, type ServerHandle } from "../server.ts";

/**
 * The dashboard's usage read over HTTP (§17.1 browser surface).
 *
 * Same rules as every browser route: Origin allowlist first, then the session
 * cookie, `no-store` on the answer. The payload is the owner's own usage
 * accounting, scoped inside the query itself.
 */

const origin = "https://cc.example.test";

let handle: ServerHandle | undefined;

async function start() {
  const db = new Database(":memory:");
  migrate(db);

  db.query(
    "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("user-1", "owner", "hash", 1, Date.now());
  db.query("INSERT INTO runners (id, owner_id, created_at) VALUES ('runner-1', 'user-1', ?)").run(
    Date.now(),
  );

  const auth = new AuthService({ db, signer: createSigner(new Uint8Array(32).fill(11)) });
  handle = createServer({
    db,
    auth,
    allowedOrigins: [origin],
    verifyRunnerCredential: (credential) => verifyRunnerCredential(db, credential),
  });
  const cookie = `cc_session=${await auth.issueAccessToken("user-1")}`;
  return { db, url: `http://127.0.0.1:${handle.server.port}`, cookie };
}

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

describe("usage stats route", () => {
  test("aggregates the owner's usage over the journal", async () => {
    const { db, url, cookie } = await start();
    ingestEvent(db, {
      eventId: "evt-1",
      runnerId: "runner-1",
      bootId: "boot-1",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      localSequence: 1,
      occurredAt: new Date().toISOString(),
      type: "message.completed",
      payload: {
        message: { usage: { input_tokens: 120, output_tokens: 30 } },
      },
    });

    const response = await fetch(`${url}/api/stats/usage`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as {
      totals: { inputTokens: number; outputTokens: number };
      daily: unknown[];
      sessions: number;
    };
    expect(body.totals.inputTokens).toBe(120);
    expect(body.totals.outputTokens).toBe(30);
    expect(body.daily.length).toBeGreaterThan(0);
    expect(body.sessions).toBe(1);
  });

  test("an empty journal answers zeros, not an error", async () => {
    const { url, cookie } = await start();

    const response = await fetch(`${url}/api/stats/usage`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    const body = (await response.json()) as { totals: { inputTokens: number } };

    expect(response.status).toBe(200);
    expect(body.totals.inputTokens).toBe(0);
  });

  test("a foreign Origin is refused before the cookie is read", async () => {
    const { url, cookie } = await start();

    const response = await fetch(`${url}/api/stats/usage`, {
      headers: { Origin: "https://evil.example.test", Cookie: cookie },
    });
    expect(response.status).toBe(403);
  });

  test("without a session cookie the answer is the one 401", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/api/stats/usage`, {
      headers: { Origin: origin },
    });
    expect(response.status).toBe(401);
  });
});
