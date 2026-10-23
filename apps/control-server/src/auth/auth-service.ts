/**
 * Owner authentication service (ADR-0001, §19.1).
 *
 * `authenticate` is the whole point of this module: it turns "the token's
 * signature is good" into "this login is still wanted". That answer lives in the
 * database, so it is read on every check rather than cached — a cache would keep
 * a revoked token alive on whichever instance happened to hold it (§21.2).
 *
 * Every failure path fails closed. A query error is not "no revocation found".
 */

import type { Database } from "bun:sqlite";
import type { Signer } from "./tokens.ts";

export type AuthOptions = {
  db: Database;
  signer: Signer;
  /** Access-token lifetime. Short by design; the refresh path extends it. */
  accessTtlSeconds?: number;
};

export type AuthenticateResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "missing_token" | "invalid_token" | "revoked" | "unknown_user" | "unavailable" };

type UserRow = { id: string; token_version: number };

export class AuthService {
  readonly #db: Database;
  readonly #signer: Signer;
  readonly #accessTtl: number;

  constructor(options: AuthOptions) {
    this.#db = options.db;
    this.#signer = options.signer;
    this.#accessTtl = options.accessTtlSeconds ?? 15 * 60;
  }

  async issueAccessToken(userId: string): Promise<string> {
    const user = this.#readUser(userId);
    if (!user) {
      // Minting a token for a missing user would produce a credential that can
      // never authenticate; failing here points at the real problem.
      throw new Error(`unknown user: ${userId}`);
    }
    return this.#signer.sign({ sub: user.id, tokenVersion: user.token_version }, this.#accessTtl);
  }

  async authenticate(token: string | undefined): Promise<AuthenticateResult> {
    if (!token) return { ok: false, reason: "missing_token" };

    const verified = await this.#signer.verify(token);
    if (!verified.ok) return { ok: false, reason: "invalid_token" };

    let user: UserRow | null;
    try {
      user = this.#readUser(verified.claims.sub);
    } catch {
      // §19.1 fail closed: the control DB is on the auth critical path.
      return { ok: false, reason: "unavailable" };
    }

    if (!user) return { ok: false, reason: "unknown_user" };

    if (user.token_version !== verified.claims.tokenVersion) {
      // The signature was valid when minted; the session has since been revoked.
      return { ok: false, reason: "revoked" };
    }

    return { ok: true, userId: user.id };
  }

  /** Invalidates every outstanding access token for this user. */
  revokeAllSessions(userId: string): void {
    this.#db
      .query("UPDATE users SET token_version = token_version + 1 WHERE id = ?")
      .run(userId);
  }

  #readUser(userId: string): UserRow | null {
    const row = this.#db
      .query("SELECT id, token_version FROM users WHERE id = ?")
      .get(userId) as UserRow | null;
    return row ?? null;
  }
}
