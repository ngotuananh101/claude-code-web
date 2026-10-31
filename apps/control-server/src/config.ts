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
import { dirname, join } from "node:path";
import { CommandOutbox, verifyRunnerCredential } from "@cc-web/control-db";
import { AuthService } from "./auth/auth-service.ts";
import { hashPassword, verifyPassword } from "./auth/password.ts";
import { createSigner } from "./auth/tokens.ts";
import { createSecretBox } from "./config/secret-box.ts";
import type { ServerOptions } from "./server.ts";

/** Where the control server keeps its state on disk. */
export type DataPaths = {
  /** SQLite file. */
  dbPath: string;
  /** Root directory for uploaded session attachments. */
  attachmentsDir: string;
};

/**
 * Resolve the persistent paths from the environment (§20.2).
 *
 * `CC_WEB_DATA_DIR` is the single knob a container needs: both the database and
 * the attachment store live under it unless the finer-grained variables override
 * them. `CC_WEB_ATTACHMENTS_DIR` exists because a deployment may want uploads on
 * a different volume from the database. Resolving here rather than inline in
 * `index.ts` keeps the fallback order testable.
 */
export function resolveDataPaths(env: Record<string, string | undefined> = process.env): DataPaths {
  const dataDir = env["CC_WEB_DATA_DIR"];
  const dbPath = env["CC_WEB_DB"] ?? join(dataDir ?? "data", "control.sqlite");
  const attachmentsDir =
    env["CC_WEB_ATTACHMENTS_DIR"] ?? join(dataDir ?? dirname(dbPath), "attachments");
  return { dbPath, attachmentsDir };
}

export type ServerConfig = {
  db: Database;
  /** Raw bytes of the JWT signing secret. `createSigner` rejects a short one. */
  secret: Uint8Array;
  allowedOrigins: string[];
  /** Fixed listen port for the vite dev proxy; omitted means ephemeral. */
  port?: number;
  /** Directory where session attachments are stored on disk. */
  attachmentsDir?: string;
};

export function buildServerOptions(config: ServerConfig): ServerOptions {
  const auth = new AuthService({ db: config.db, signer: createSigner(config.secret) });

  return {
    db: config.db,
    auth,
    allowedOrigins: config.allowedOrigins,
    ...(config.port === undefined ? {} : { port: config.port }),
    ...(config.attachmentsDir === undefined ? {} : { attachmentsDir: config.attachmentsDir }),
    // §18.1, P3-C Task 5b: derive the secret box from the server secret so the
    // same key seals every profile at rest across restarts.
    secretBox: createSecretBox(config.secret),
    // Read through the database on every upgrade, so a rotation or revoke takes
    // effect on the next connection rather than at the next restart (§6.3).
    verifyRunnerCredential: (credential) => {
      const result = verifyRunnerCredential(config.db, credential);
      return result.ok
        ? { ok: true, runnerId: result.runnerId, ownerId: result.ownerId }
        : { ok: false, reason: "unknown" };
    },
    verifyPassword,
    hashPassword,
    // The real outbox. Without it a runner that reaches `ready` is never sent
    // anything: the scheduler's commands are written durably and then sit there.
    outbox: new CommandOutbox(config.db),
  };
}
