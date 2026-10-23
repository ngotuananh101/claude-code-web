/**
 * Server composition from configuration (§17, §19.1).
 *
 * Everything here was previously inline in `index.ts`, where it could not be
 * tested: the entrypoint reads environment variables and installs signal
 * handlers, and neither is worth faking. This module holds the decisions those
 * variables feed into, so the wiring can be exercised directly.
 *
 * Both verifiers are real. They used to be stubs that refused everything —
 * which is safe, but indistinguishable from "nobody can log in" until someone
 * tries.
 */

import type { Database } from "bun:sqlite";
import { verifyRunnerCredential } from "@cc-web/control-db";
import { AuthService } from "./auth/auth-service.ts";
import { verifyPassword } from "./auth/password.ts";
import { createSigner } from "./auth/tokens.ts";
import type { ServerOptions } from "./server.ts";

export type ServerConfig = {
  db: Database;
  /** Raw bytes of the JWT signing secret. `createSigner` rejects a short one. */
  secret: Uint8Array;
  allowedOrigins: string[];
};

export function buildServerOptions(config: ServerConfig): ServerOptions {
  const auth = new AuthService({ db: config.db, signer: createSigner(config.secret) });

  return {
    db: config.db,
    auth,
    allowedOrigins: config.allowedOrigins,
    // Read through the database on every upgrade, so a rotation or revoke takes
    // effect on the next connection rather than at the next restart (§6.3).
    verifyRunnerCredential: (credential) => {
      const result = verifyRunnerCredential(config.db, credential);
      return result.ok
        ? { ok: true, runnerId: result.runnerId, ownerId: result.ownerId }
        : { ok: false, reason: "unknown" };
    },
    verifyPassword,
  };
}
