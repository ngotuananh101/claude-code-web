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
 * `index.ts` used to wire two stubs: a credential verifier that refused
 * everything and a password verifier that refused everything. Both are now
 * real, and these tests exist because "wired but refusing" looks identical to
 * "working" until someone tries to log in or enroll a runner.
 *
 * `buildServerOptions` is the part of the entrypoint that is testable; the rest
 * reads environment variables and signals.
 */

const secret = new Uint8Array(32).fill(17);
const origin = "https://cc.example.test";

let handle: ServerHandle | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

async function start(config: Partial<ServerConfig> = {}) {
  const db = new Database(":memory:");
  migrate(db);
  db.query(
    "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("user-1", "owner", await hashPassword("correct horse"), 1, Date.now());

  const options = buildServerOptions({
    db,
    secret,
    allowedOrigins: [origin],
    ...config,
  });

  handle = createServer(options);
  return { db, url: `http://127.0.0.1:${handle.server.port}` };
}

describe("the real control server wiring", () => {
  test("login succeeds with the stored password", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ username: "owner", password: "correct horse" }),
    });

    // With the old stub this was a 401 for every password, which reads as "the
    // owner typed it wrong" rather than "nobody can log in".
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("cc_session=");
  });

  test("login refuses a wrong password", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ username: "owner", password: "wrong" }),
    });

    expect(response.status).toBe(401);
  });

  test("an enrolled runner credential is accepted by the gateway", async () => {
    const { db, url } = await start();

    // Enroll through the HTTP surface, then verify the same credential through
    // the composition used by the real entrypoint. If these two disagree, the
    // enrollment endpoint is writing something the gateway cannot read.
    const login = await fetch(`${url}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ username: "owner", password: "correct horse" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const created = (await (
      await fetch(`${url}/api/runner-enrollments`, {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie },
      })
    ).json()) as { token: string };

    const enrolled = (await (
      await fetch(`${url}/api/runner-enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: created.token }),
      })
    ).json()) as { runnerId: string; credential: string };

    const check = verifyRunnerCredential(db, enrolled.credential);
    expect(check).toMatchObject({ ok: true, runnerId: enrolled.runnerId, ownerId: "user-1" });
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
