import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "@cc-web/control-db";
import { decodeJwt } from "jose";
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

  test("issueRefreshToken mints a refresh token that verifies with verifyRefreshToken", async () => {
    const { db, auth } = service();
    addUser(db);
    const refreshToken = await auth.issueRefreshToken("user-1");

    const result = await auth.verifyRefreshToken(refreshToken);
    expect(result).toEqual({ ok: true, userId: "user-1" });
  });

  test("authenticate refuses a refresh token (prevents type confusion)", async () => {
    const { db, auth } = service();
    addUser(db);
    const refreshToken = await auth.issueRefreshToken("user-1");

    const result = await auth.authenticate(refreshToken);
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  test("verifyRefreshToken refuses an access token (prevents type confusion)", async () => {
    const { db, auth } = service();
    addUser(db);
    const accessToken = await auth.issueAccessToken("user-1");

    const result = await auth.verifyRefreshToken(accessToken);
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  test("bumping token version invalidates refresh tokens", async () => {
    const { db, auth } = service();
    addUser(db);
    const refreshToken = await auth.issueRefreshToken("user-1");

    db.query("UPDATE users SET token_version = token_version + 1 WHERE id = ?").run("user-1");

    expect(await auth.verifyRefreshToken(refreshToken)).toEqual({ ok: false, reason: "revoked" });
  });

  test("rememberMe sets a 30-day refresh TTL while keeping the access token at 15 minutes", async () => {
    const { db, auth } = service();
    addUser(db);

    const accessRemembered = await auth.issueAccessToken("user-1", true);
    const refreshRemembered = await auth.issueRefreshToken("user-1", true);
    const refreshSession = await auth.issueRefreshToken("user-1", false);
    const refreshLegacy = await auth.issueRefreshToken("user-1");

    const accessClaims = decodeJwt(accessRemembered);
    const rememberedClaims = decodeJwt(refreshRemembered);
    const sessionClaims = decodeJwt(refreshSession);
    const legacyClaims = decodeJwt(refreshLegacy);

    expect((accessClaims.exp ?? 0) - (accessClaims.iat ?? 0)).toBe(900);
    expect((rememberedClaims.exp ?? 0) - (rememberedClaims.iat ?? 0)).toBe(2_592_000);
    expect((sessionClaims.exp ?? 0) - (sessionClaims.iat ?? 0)).toBe(604_800);
    expect((legacyClaims.exp ?? 0) - (legacyClaims.iat ?? 0)).toBe(604_800);

    expect(await auth.authenticate(accessRemembered)).toEqual({
      ok: true,
      userId: "user-1",
      rememberMe: true,
    });
    expect(await auth.verifyRefreshToken(refreshRemembered)).toEqual({
      ok: true,
      userId: "user-1",
      rememberMe: true,
    });
    expect(await auth.verifyRefreshToken(refreshSession)).toEqual({
      ok: true,
      userId: "user-1",
      rememberMe: false,
    });
  });

  test("refresh preserves the signed rememberMe policy across true, false, and legacy tokens", async () => {
    const { db, auth } = service();
    addUser(db);

    const rememberedRefresh = await auth.issueRefreshToken("user-1", true);
    const rotatedRemembered = await auth.refresh(rememberedRefresh);
    expect(rotatedRemembered.ok).toBe(true);
    if (rotatedRemembered.ok) {
      expect(rotatedRemembered.rememberMe).toBe(true);
      expect(await auth.authenticate(rotatedRemembered.accessToken)).toEqual({
        ok: true,
        userId: "user-1",
        rememberMe: true,
      });
      const claims = decodeJwt(rotatedRemembered.refreshToken);
      expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(2_592_000);
    }

    const sessionRefresh = await auth.issueRefreshToken("user-1", false);
    const rotatedSession = await auth.refresh(sessionRefresh);
    expect(rotatedSession.ok).toBe(true);
    if (rotatedSession.ok) {
      expect(rotatedSession.rememberMe).toBe(false);
      expect(await auth.authenticate(rotatedSession.accessToken)).toEqual({
        ok: true,
        userId: "user-1",
        rememberMe: false,
      });
      const claims = decodeJwt(rotatedSession.refreshToken);
      expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(604_800);
    }

    const legacyRefresh = await auth.issueRefreshToken("user-1");
    const rotatedLegacy = await auth.refresh(legacyRefresh);
    expect(rotatedLegacy.ok).toBe(true);
    if (rotatedLegacy.ok) {
      expect("rememberMe" in rotatedLegacy).toBe(false);
      expect(await auth.authenticate(rotatedLegacy.accessToken)).toEqual({
        ok: true,
        userId: "user-1",
      });
      const claims = decodeJwt(rotatedLegacy.refreshToken);
      expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(604_800);
    }
  });

  test("bumping token version invalidates remembered refresh tokens during refresh", async () => {
    const { db, auth } = service();
    addUser(db);
    const rememberedRefresh = await auth.issueRefreshToken("user-1", true);

    auth.revokeAllSessions("user-1");

    expect(await auth.refresh(rememberedRefresh)).toEqual({ ok: false, reason: "revoked" });
  });
});
