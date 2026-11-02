import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { migrate } from "@cc-web/control-db";
import { AuthService } from "../auth/auth-service.ts";
import { createSigner } from "../auth/tokens.ts";
import { createServer, type RunnerCredentialCheck, type ServerHandle } from "../server.ts";

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
    "INSERT INTO users (id, username, password_hash, token_version, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("user-1", "ngotuananh2101", "hash:password123", 1, null, Date.now());

  const auth = new AuthService({ db, signer: createSigner(new Uint8Array(32).fill(11)) });
  handle = createServer({
    db,
    auth,
    allowedOrigins: [origin],
    verifyRunnerCredential: (): RunnerCredentialCheck => ({ ok: false, reason: "unknown" }),
    verifyPassword: async (p, h) => {
      if (h.startsWith("hash:")) {
        return `hash:${p}` === h;
      }
      try {
        return await Bun.password.verify(p, h);
      } catch {
        return false;
      }
    },
    hashPassword: async (p) => `hash:${p}`,
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

    const body = (await response.json()) as { username: string; avatar: string | null };
    expect(body.username).toBe("ngotuananh2101");
    expect(body.avatar).toBeNull();
  });

  test("answers avatar when set", async () => {
    const { db, url, cookie } = await start();
    db.query("UPDATE users SET avatar = ? WHERE id = ?").run(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "user-1",
    );

    const response = await fetch(`${url}/api/me`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { username: string; avatar: string | null };
    expect(body.username).toBe("ngotuananh2101");
    expect(body.avatar).toBe(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    );
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

  // PATCH /api/me tests

  describe("PATCH /api/me", () => {
    test("updates username successfully", async () => {
      const { db, url, cookie } = await start();

      const response = await fetch(`${url}/api/me`, {
        method: "PATCH",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username: "newusername" }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");

      const body = (await response.json()) as {
        ok: boolean;
        username: string;
        avatar: string | null;
      };
      expect(body.ok).toBe(true);
      expect(body.username).toBe("newusername");
      expect(body.avatar).toBeNull();

      // Verify DB update
      const row = db.query("SELECT username FROM users WHERE id = 'user-1'").get() as {
        username: string;
      } | null;
      expect(row?.username).toBe("newusername");
    });

    test("returns 409 Conflict if username already taken by another user", async () => {
      const { db, url, cookie } = await start();
      db.query(
        "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("user-2", "existinguser", "hash:password", 1, Date.now());

      const response = await fetch(`${url}/api/me`, {
        method: "PATCH",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username: "existinguser" }),
      });

      expect(response.status).toBe(409);

      const body = (await response.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("Username already taken");
    });

    test("updates avatar data URI", async () => {
      const { db, url, cookie } = await start();

      const avatarData =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      db.query("UPDATE users SET avatar = ? WHERE id = ?").run(avatarData, "user-1");

      const response = await fetch(`${url}/api/me`, {
        method: "PATCH",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ avatar: avatarData }),
      });

      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        ok: boolean;
        username: string;
        avatar: string | null;
      };
      expect(body.ok).toBe(true);
      expect(body.avatar).toBe(avatarData);

      // Verify DB update - re-fetch avatar from server to confirm it was stored
      const fetchRes = await fetch(`${url}/api/me`, {
        headers: { Origin: origin, Cookie: cookie },
      });
      const fetchBody = (await fetchRes.json()) as { username: string; avatar: string | null };
      expect(fetchBody.avatar).toBe(avatarData);
    });

    test("clears avatar with null", async () => {
      const { db, url, cookie } = await start();
      db.query("UPDATE users SET avatar = ? WHERE id = ?").run(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "user-1",
      );

      const response = await fetch(`${url}/api/me`, {
        method: "PATCH",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ avatar: null }),
      });

      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        ok: boolean;
        username: string;
        avatar: string | null;
      };
      expect(body.ok).toBe(true);
      expect(body.avatar).toBeNull();

      // Verify DB update
      const row = db.query("SELECT avatar FROM users WHERE id = 'user-1'").get() as {
        avatar: string | null;
      };
      expect(row.avatar).toBeNull();
    });

    test("clears avatar with empty string", async () => {
      const { db, url, cookie } = await start();
      db.query("UPDATE users SET avatar = ? WHERE id = ?").run(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "user-1",
      );

      const response = await fetch(`${url}/api/me`, {
        method: "PATCH",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ avatar: "" }),
      });

      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        ok: boolean;
        username: string;
        avatar: string | null;
      };
      expect(body.ok).toBe(true);
      expect(body.avatar).toBeNull();
    });

    test("with newPassword succeeds when currentPassword is valid and sets updated Set-Cookie headers", async () => {
      const { db, url, cookie } = await start();

      const response = await fetch(`${url}/api/me`, {
        method: "PATCH",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword: "password123",
          newPassword: "newpassword456",
        }),
      });

      expect(response.status).toBe(200);

      const cookies = response.headers.getSetCookie();
      expect(cookies.length).toBeGreaterThanOrEqual(2);
      expect(cookies.some((c) => c.includes("cc_session="))).toBe(true);
      expect(cookies.some((c) => c.includes("cc_refresh="))).toBe(true);

      const body = (await response.json()) as {
        ok: boolean;
        username: string;
        avatar: string | null;
      };
      expect(body.ok).toBe(true);
      expect(body.username).toBe("ngotuananh2101");

      // Verify password changed and token_version bumped
      const user = db
        .query("SELECT id, token_version, password_hash FROM users WHERE id = 'user-1'")
        .get() as { id: string; token_version: number; password_hash: string };
      expect(user.token_version).toBe(2);
      // New password should hash to "hash:newpassword456" (using the test hashPassword function)
      expect(user.password_hash).toBe("hash:newpassword456");
    });

    test("with newPassword fails (400) when currentPassword is invalid", async () => {
      const { url, cookie } = await start();

      const response = await fetch(`${url}/api/me`, {
        method: "PATCH",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword: "wrongpassword",
          newPassword: "newpassword456",
        }),
      });

      expect(response.status).toBe(400);

      const body = (await response.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("Mật khẩu hiện tại không đúng");
    });

    test("requires currentPassword when newPassword is provided", async () => {
      const { url, cookie } = await start();

      const response = await fetch(`${url}/api/me`, {
        method: "PATCH",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ newPassword: "newpassword456" }),
      });

      expect(response.status).toBe(400);

      const body = (await response.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("Mật khẩu hiện tại không đúng");
    });

    test("newPassword requires minimum length of 8 characters", async () => {
      const { url, cookie } = await start();

      const response = await fetch(`${url}/api/me`, {
        method: "PATCH",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword: "password123",
          newPassword: "short",
        }),
      });

      expect(response.status).toBe(400);

      const body = (await response.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
    });

    test("validates username format (alphanumeric, underscore, dot, hyphen, 2-32 chars)", async () => {
      const { url, cookie } = await start();

      const invalidUsernames = [
        "a",
        "user@name",
        "user name",
        "user!name",
        "user#name",
        "user$name",
      ];
      for (const username of invalidUsernames) {
        const response = await fetch(`${url}/api/me`, {
          method: "PATCH",
          headers: {
            Origin: origin,
            Cookie: cookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ username }),
        });

        expect(response.status).toBe(400);
      }
    });

    test("validates avatar data URI format", async () => {
      const { url, cookie } = await start();

      const invalidAvatars = [
        "not-a-data-uri",
        "data:text/plain;base64,SGVsbG8=",
        "data:image/png;base64,",
        "data:image/jpeg;base64,",
      ];

      for (const avatar of invalidAvatars) {
        const response = await fetch(`${url}/api/me`, {
          method: "PATCH",
          headers: {
            Origin: origin,
            Cookie: cookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ avatar }),
        });

        expect(response.status).toBe(400);
      }
    });

    test("rejects avatar larger than 256KB", async () => {
      const { url, cookie } = await start();

      // Need ~262144+ base64 chars to exceed 256KB after decode
      // 262144 bytes raw = 349526 base64 chars (262144 * 4/3)
      const largeAvatar = `data:image/png;base64,${"a".repeat(349526)}`;

      const response = await fetch(`${url}/api/me`, {
        method: "PATCH",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ avatar: largeAvatar }),
      });

      expect(response.status).toBe(400);
    });

    test("refuses foreign Origin", async () => {
      const { url, cookie } = await start();

      const response = await fetch(`${url}/api/me`, {
        method: "PATCH",
        headers: {
          Origin: "https://evil.example.test",
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username: "newuser" }),
      });

      expect(response.status).toBe(403);
    });
  });
});
