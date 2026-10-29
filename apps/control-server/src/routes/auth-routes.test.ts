import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { migrate } from "@cc-web/control-db";
import { AuthService } from "../auth/auth-service.ts";
import { createSigner } from "../auth/tokens.ts";
import { createServer, type RunnerCredentialCheck, type ServerHandle } from "../server.ts";

/**
 * First-time setup endpoints (§19.1).
 *
 * `GET /auth/setup-status` asks whether the owner account exists — the web
 * surface uses it to decide whether to show the setup form or the login form.
 * `POST /auth/setup` is the one chance to create that account; it is locked to
 * the moment when the users table is empty and Origin-checked like every other
 * browser route.
 */

const origin = "https://cc.example.test";
const secret = new Uint8Array(32).fill(7);

let handle: ServerHandle | undefined;

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

async function startServer(db: Database, hashPassword?: (plain: string) => Promise<string>) {
  const auth = new AuthService({ db, signer: createSigner(secret) });
  handle = createServer({
    db,
    auth,
    allowedOrigins: [origin],
    verifyRunnerCredential: (): RunnerCredentialCheck => ({ ok: false, reason: "unknown" }),
    ...(hashPassword ? { hashPassword } : {}),
  });
  return { db, auth, url: `http://127.0.0.1:${handle.server.port}` };
}

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

describe("auth setup endpoints", () => {
  test("GET /auth/setup-status returns setupRequired: true on fresh DB", async () => {
    const { url } = await startServer(freshDb());

    const response = await fetch(`${url}/auth/setup-status`, { method: "GET" });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { setupRequired: boolean };
    expect(body).toEqual({ setupRequired: true });
  });

  test("GET /auth/setup-status returns setupRequired: false when users exist", async () => {
    const db = freshDb();
    db.query(
      "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("user-1", "ngotuananh2101", "hash", 1, Date.now());

    const { url } = await startServer(db);

    const response = await fetch(`${url}/auth/setup-status`, { method: "GET" });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { setupRequired: boolean };
    expect(body).toEqual({ setupRequired: false });
  });

  test("GET /auth/setup-status rejects foreign origin", async () => {
    const { url } = await startServer(freshDb());

    const response = await fetch(`${url}/auth/setup-status`, {
      method: "GET",
      headers: { Origin: "https://evil.example.test" },
    });
    expect(response.status).toBe(403);
  });

  test("POST /auth/setup creates the first user and sets session cookie", async () => {
    const stored = await startServer(freshDb(), async (plain) => `hash:${plain}`);

    const response = await fetch(`${stored.url}/auth/setup`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ngotuananh2101", password: "hunter2" }),
    });

    expect(response.status).toBe(201);
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("cc_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");

    const body = (await response.json()) as { ok: boolean; user: { id: string; username: string } };
    expect(body.ok).toBe(true);
    expect(body.user.username).toBe("ngotuananh2101");
    expect(body.user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // The user is actually persisted with the hashed password.
    const row = stored.db
      .query("SELECT id, username, password_hash FROM users WHERE username = ?")
      .get("ngotuananh2101") as { id: string; username: string; password_hash: string } | null;
    expect(row).not.toBeNull();
    expect(row?.id).toBe(body.user.id);
    expect(row?.password_hash).toBe("hash:hunter2");
  });

  test("POST /auth/setup refuses if users already exist (403)", async () => {
    const db = freshDb();
    db.query(
      "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("user-1", "ngotuananh2101", "hash", 1, Date.now());

    const { url } = await startServer(db, async (plain) => `hash:${plain}`);

    const response = await fetch(`${url}/auth/setup`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "second", password: "hunter2" }),
    });

    expect(response.status).toBe(403);
  });

  test("POST /auth/setup validates origin and rejects foreign origin", async () => {
    const { url } = await startServer(freshDb(), async (plain) => `hash:${plain}`);

    const response = await fetch(`${url}/auth/setup`, {
      method: "POST",
      headers: { Origin: "https://evil.example.test", "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ngotuananh2101", password: "hunter2" }),
    });

    expect(response.status).toBe(403);
  });

  test("POST /auth/setup validates input parameters", async () => {
    const { url } = await startServer(freshDb(), async (plain) => `hash:${plain}`);

    // Missing username.
    const missingUser = await fetch(`${url}/auth/setup`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "hunter2" }),
    });
    expect(missingUser.status).toBe(400);

    // Missing password.
    const missingPassword = await fetch(`${url}/auth/setup`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ngotuananh2101" }),
    });
    expect(missingPassword.status).toBe(400);

    // Empty trimmed username.
    const emptyUsername = await fetch(`${url}/auth/setup`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "   ", password: "hunter2" }),
    });
    expect(emptyUsername.status).toBe(400);

    // Empty password.
    const emptyPassword = await fetch(`${url}/auth/setup`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ngotuananh2101", password: "" }),
    });
    expect(emptyPassword.status).toBe(400);
  });

  test("POST /auth/setup race condition: concurrent calls result in exactly one winner", async () => {
    const stored = await startServer(freshDb(), async (plain) => `hash:${plain}`);

    const [res1, res2] = await Promise.all([
      fetch(`${stored.url}/auth/setup`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ username: "winner1", password: "password123" }),
      }),
      fetch(`${stored.url}/auth/setup`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ username: "winner2", password: "password123" }),
      }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 403]);

    const usersCount = (
      stored.db.query("SELECT COUNT(*) AS count FROM users").get() as { count: number }
    ).count;
    expect(usersCount).toBe(1);
  });
});
