/**
 * Server composition from configuration (§17, §19.1).
 *
 * Everything here was previously inline in `index.ts`, where it could not be
 * tested: the entrypoint reads environment variables and installs signal
 * handlers, and neither is worth faking. This module holds the decisions those
 * variables feed into, so the wiring can be exercised directly.
 *
 * Auth is the real better-auth instance (ADR-0002), backed by the same database
 * every repository reads; the runner verifier is real too — it used to be a
 * stub that refused everything, which is safe but indistinguishable from
 * "nobody can connect" until someone tries.
 */

import type { Database } from "bun:sqlite";
import { CommandOutbox, verifyRunnerCredential } from "@cc-web/control-db";
import { createBetterAuth } from "./auth/better-auth.ts";
import type { ServerOptions } from "./server.ts";

export type ServerConfig = {
  db: Database;
  /** Canonical server origin, e.g. http://localhost:8787 (BETTER_AUTH_URL). */
  baseURL: string;
  /** Session-signing secret (BETTER_AUTH_SECRET). */
  secret: string;
  allowedOrigins: string[];
  /** Fixed listen port for the vite dev proxy; omitted means ephemeral. */
  port?: number;
};

export function buildServerOptions(config: ServerConfig): ServerOptions {
  return {
    db: config.db,
    auth: createBetterAuth(config.db, {
      baseURL: config.baseURL,
      secret: config.secret,
      trustedOrigins: config.allowedOrigins,
    }),
    allowedOrigins: config.allowedOrigins,
    ...(config.port === undefined ? {} : { port: config.port }),
    // Read through the database on every upgrade, so a rotation or revoke takes
    // effect on the next connection rather than at the next restart (§6.3).
    verifyRunnerCredential: (credential) => {
      const result = verifyRunnerCredential(config.db, credential);
      return result.ok
        ? { ok: true, runnerId: result.runnerId, ownerId: result.ownerId }
        : { ok: false, reason: "unknown" };
    },
    // The real outbox. Without it a runner that reaches `ready` is never sent
    // anything: the scheduler's commands are written durably and then sit there.
    outbox: new CommandOutbox(config.db),
  };
}
