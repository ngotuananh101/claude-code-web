import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  issueRunnerCredential,
  migrate,
  revokeRunner,
  verifyRunnerCredential,
} from "@cc-web/control-db";
import { hashPassword } from "./auth/password.ts";
import { buildServerOptions, type ServerConfig } from "./config.ts";
import { createServer, type ServerHandle } from "./server.ts";

/**
 * The real composition (§19.1, §6.1).
 *
 * `index.ts` reads environment variables and installs signal handlers; neither
 * is worth faking. `buildServerOptions` is the testable part of the entrypoint,
 * and these tests exist because "wired but refusing" looks identical to
 * "working" until someone tries to sign in or connect a runner.
 */

const origin = "https://cc.example.test";

let handle: ServerHandle | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

async function start(config: Partial<ServerConfig> = {}) {
  const db = new Database(":memory:");
  migrate(db);

  const options = buildServerOptions({
    db,
    secret: new Uint8Array(32).fill(5),
    allowedOrigins: [origin],
    ...config,
  });

  db.query(
    "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("user-1", "owner", await hashPassword("correct horse"), 1, Date.now());

  handle = createServer(options);
  return { db, url: `http://127.0.0.1:${handle.server.port}` };
}

async function signIn(url: string, password: string): Promise<Response> {
  return fetch(`${url}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ username: "owner", password }),
  });
}

describe("the real control server wiring", () => {
  test("login succeeds with the stored password and sets the session cookie", async () => {
    const { url } = await start();

    const response = await signIn(url, "correct horse");

    // With a refusing stub this was a 401 for every password, which reads as
    // "the owner typed it wrong" rather than "nobody can log in".
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("cc_session=");
  });

  test("login refuses a wrong password", async () => {
    const { url } = await start();

    const response = await signIn(url, "wrong");

    expect(response.status).toBe(401);
  });

  test("a minted connector token is accepted by the gateway", async () => {
    const { db, url } = await start();

    // Mint through the HTTP surface, then verify the same token through the
    // composition used by the real entrypoint. If these two disagree, the
    // registry endpoint is writing something the gateway cannot read.
    const login = await signIn(url, "correct horse");
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const minted = (await (
      await fetch(`${url}/api/runners`, {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie },
      })
    ).json()) as { runnerId: string; token: string };

    const check = verifyRunnerCredential(db, minted.token);
    expect(check.ok).toBe(true);
    expect(check).toMatchObject({ runnerId: minted.runnerId });
  });

  test("a revoked runner credential is refused", async () => {
    const { db } = await start();

    const issued = issueRunnerCredential(db, { id: "runner-x", ownerId: "user-1" });
    expect(verifyRunnerCredential(db, issued.credential).ok).toBe(true);

    revokeRunner(db, { runnerId: "runner-x", ownerId: "user-1" });

    // Revocation has to reach the verifier the gateway uses, not just the row.
    expect(verifyRunnerCredential(db, issued.credential)).toMatchObject({ ok: false });
  });

  test("the real composition can dispatch: outbox and dispatcher are wired", async () => {
    const { url } = await start();

    // Without an outbox the server accepts a dispatch decision, writes the
    // command durably, and never sends it. That failure is silent — every unit
    // test of the scheduler passes — so the composition itself is asserted.
    expect(handle!.dispatcher).toBeDefined();

    // And the scheduler delivers through it, rather than only persisting.
    const decision = await handle!.scheduler.dispatch(
      {
        sessionId: "session-1",
        runId: "run-1",
        attemptId: "attempt-1",
        workspaceId: "workspace-1",
        prompt: "hello",
      },
      { runnerId: "runner-a", state: "ready", maxConcurrentRuns: 1, activeRuns: 0 },
    );
    expect(decision.ok).toBe(true);

    // No runner is connected, so the command stays deliverable rather than
    // being marked sent into a socket that does not exist.
    expect(handle!.dispatcher!.drain("runner-a")).toEqual({ sent: 0, skipped: 1 });

    void url;
  });
});
