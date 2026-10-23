import { describe, expect, test } from "bun:test";
import { createSigner, type Signer } from "./tokens.ts";

/**
 * Owner access tokens (ADR-0001).
 *
 * A JWT proves issuance, not that the session is still wanted. So the token
 * carries the `tokenVersion` it was minted under, and verification only checks
 * the signature — the caller compares the version against the database. Keeping
 * those two jobs apart is what makes revocation possible at all.
 */

const secret = new Uint8Array(32).fill(7);

function signer(): Signer {
  return createSigner(secret);
}

describe("token signing", () => {
  test("a freshly signed token verifies and carries its claims", async () => {
    const tokens = signer();
    const token = await tokens.sign({ sub: "user-1", tokenVersion: 3 }, 60);

    const result = await tokens.verify(token);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe("user-1");
      expect(result.claims.tokenVersion).toBe(3);
    }
  });

  test("an expired token is refused", async () => {
    const tokens = signer();
    // Negative TTL: the token was valid an hour ago and is not now.
    const token = await tokens.sign({ sub: "user-1", tokenVersion: 1 }, -3600);

    const result = await tokens.verify(token);

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  test("a token signed with another secret is refused", async () => {
    const foreign = createSigner(new Uint8Array(32).fill(9));
    const token = await foreign.sign({ sub: "user-1", tokenVersion: 1 }, 60);

    const result = await signer().verify(token);

    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  test("an unsigned token is refused, not read", async () => {
    // The classic `alg: none` attack: claims are plain JSON, so accepting it
    // would let anyone mint any identity.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "attacker", tokenVersion: 1, exp: 9999999999 })).toString("base64url");

    const result = await signer().verify(`${header}.${payload}.`);

    expect(result.ok).toBe(false);
  });

  test("a tampered payload is refused", async () => {
    const tokens = signer();
    const token = await tokens.sign({ sub: "user-1", tokenVersion: 1 }, 60);
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "attacker", tokenVersion: 1 })).toString("base64url");

    const result = await tokens.verify(`${header}.${forged}.${signature}`);

    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  test("garbage input is refused rather than throwing", async () => {
    const result = await signer().verify("not-a-token");

    expect(result.ok).toBe(false);
  });

  test("a token without a tokenVersion claim is refused", async () => {
    // Without the version there is nothing to compare against the database, so
    // the token could never be revoked. Refusing is the only safe answer.
    const tokens = signer();
    const token = await tokens.sign({ sub: "user-1" } as never, 60);

    const result = await tokens.verify(token);

    expect(result.ok).toBe(false);
  });

  test("a short secret is rejected at construction", () => {
    // HS256 with a 1-byte secret is trivially brute-forced. Failing at startup
    // beats failing silently forever.
    expect(() => createSigner(new Uint8Array(4))).toThrow(/secret/i);
  });
});
