import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "@cc-web/control-db";
import { AuthService } from "./auth-service.ts";
import { createSigner } from "./tokens.ts";

/**
 * Revocation (ADR-0001, §19.1).
 *
 * A signed token is not a live session. The service compares the token's
 * `tokenVersion` against the user row on every check, so bumping the version
 * invalidates every outstanding token for that user at once — which is the only
 * way a stateless JWT can honour "revoke login".
 */

const secret = new Uint8Array(32).fill(3);

function service() {
  const db = new Database(":memory:");
  migrate(db);

  const auth = new AuthService({ db, signer: createSigner(secret) });
  return { db, auth };
}

function addUser(db: Database, id = "user-1", version = 1): void {
  db.query(
    "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, `name-${id}`, "hash", version, Date.now());
}

describe("owner authentication", () => {
  test("a token for an existing user with a matching version is accepted", async () => {
    const { db, auth } = service();
    addUser(db);

    const token = await auth.issueAccessToken("user-1");
    const result = await auth.authenticate(token);

    expect(result).toEqual({ ok: true, userId: "user-1" });
  });

  test("bumping the user's token version invalidates every outstanding token", async () => {
    const { db, auth } = service();
    addUser(db);
    const token = await auth.issueAccessToken("user-1");

    db.query("UPDATE users SET token_version = token_version + 1 WHERE id = ?").run("user-1");

    // This is the revocation mechanism. Without it, logout is a client-side
    // promise and a stolen token stays valid until it expires.
    expect(await auth.authenticate(token)).toEqual({ ok: false, reason: "revoked" });
  });

  test("a token for a user that no longer exists is refused", async () => {
    const { db, auth } = service();
    addUser(db);
    const token = await auth.issueAccessToken("user-1");
    db.query("DELETE FROM users WHERE id = ?").run("user-1");

    expect(await auth.authenticate(token)).toEqual({ ok: false, reason: "unknown_user" });
  });

  test("issuing for a nonexistent user fails rather than minting an orphan token", async () => {
    const { auth } = service();

    await expect(auth.issueAccessToken("nobody")).rejects.toThrow(/unknown user/);
  });

  test("a valid token is refused once the database is unreachable", async () => {
    const { db, auth } = service();
    addUser(db);
    const token = await auth.issueAccessToken("user-1");
    db.close();

    // §19.1: fail closed. An auth layer that treats a database error as "no
    // revocation found" would accept every token during an outage.
    const result = await auth.authenticate(token);
    expect(result.ok).toBe(false);
  });

  test("each verification reads the current version, not a cached one", async () => {
    const { db, auth } = service();
    addUser(db);
    const token = await auth.issueAccessToken("user-1");
    expect((await auth.authenticate(token)).ok).toBe(true);

    db.query("UPDATE users SET token_version = 7 WHERE id = ?").run("user-1");

    // A cache here would defeat revocation across instances (§21.2), so the
    // second call must observe the change.
    expect(await auth.authenticate(token)).toEqual({ ok: false, reason: "revoked" });
  });
});
