/**
 * Owner access tokens (ADR-0001).
 *
 * Two jobs, deliberately separate:
 *
 *  - `sign` mints a token that names the `tokenVersion` it was issued under.
 *  - `verify` proves the token was issued by us and has not expired.
 *
 * `verify` does **not** decide whether the session is still wanted. That is a
 * database comparison the caller makes, because revocation is state and a
 * stateless token cannot carry it. Splitting the jobs here is what keeps a
 * revoked login from looking valid.
 *
 * Uses `jose`, per ADR-0001: no hand-written crypto. The algorithm is pinned to
 * HS256 at verification, so `alg: none` and algorithm confusion are rejected
 * before any claim is read.
 */

import { errors, type JWTPayload, jwtVerify, SignJWT } from "jose";

export type TokenClaims = {
  sub: string;
  /** The user's version at issuance; a mismatch with the DB means revoked. */
  tokenVersion: number;
  type?: "access" | "refresh";
};

export type VerifyResult =
  | { ok: true; claims: TokenClaims }
  | { ok: false; reason: "expired" | "invalid_signature" | "malformed" | "missing_claims" };

export type Signer = {
  sign(claims: TokenClaims, ttlSeconds: number): Promise<string>;
  verify(token: string): Promise<VerifyResult>;
};

const ALGORITHM = "HS256";
/** HS256 keys below this are brute-forceable; refuse to start instead. */
const MIN_SECRET_BYTES = 32;

export function createSigner(secret: Uint8Array): Signer {
  if (secret.length < MIN_SECRET_BYTES) {
    throw new Error(
      `signing secret must be at least ${MIN_SECRET_BYTES} bytes, got ${secret.length}`,
    );
  }

  return {
    async sign(claims, ttlSeconds) {
      const now = Math.floor(Date.now() / 1000);
      const payload: JWTPayload = { tokenVersion: claims.tokenVersion };
      if (claims.type !== undefined) {
        payload["type"] = claims.type;
      }
      return new SignJWT(payload)
        .setProtectedHeader({ alg: ALGORITHM })
        .setSubject(claims.sub)
        .setIssuedAt(now)
        .setExpirationTime(now + ttlSeconds)
        .sign(secret);
    },

    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, secret, {
          // Pinning the algorithm is what makes `alg: none` a failure rather
          // than an accepted token with no signature.
          algorithms: [ALGORITHM],
        });

        if (typeof payload.sub !== "string" || payload.sub === "") {
          return { ok: false, reason: "missing_claims" };
        }
        if (typeof payload["tokenVersion"] !== "number") {
          // Without a version there is nothing to revoke against, so a token
          // lacking one could never be invalidated.
          return { ok: false, reason: "missing_claims" };
        }

        const type =
          payload["type"] === "access" || payload["type"] === "refresh"
            ? (payload["type"] as "access" | "refresh")
            : undefined;

        return {
          ok: true,
          claims: {
            sub: payload.sub,
            tokenVersion: payload["tokenVersion"],
            ...(type !== undefined ? { type } : {}),
          },
        };
      } catch (error) {
        if (error instanceof errors.JWTExpired) {
          return { ok: false, reason: "expired" };
        }
        if (error instanceof errors.JWSSignatureVerificationFailed) {
          return { ok: false, reason: "invalid_signature" };
        }
        // Everything else — malformed structure, unknown algorithm, bad base64 —
        // is a token we cannot vouch for. One reason, not an exception.
        return { ok: false, reason: "malformed" };
      }
    },
  };
}
