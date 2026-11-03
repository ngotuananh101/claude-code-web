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
import { createSecretBox, type SecretBox } from "./config/secret-box.ts";
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
  /** Where startup warnings go; defaults to `console.warn`. */
  warn?: (message: string) => void;
  /**
   * Separate key for sealing stored profile API keys (SecretBox).
   * When omitted, the JWT secret is used for backward compatibility —
   * that is the old behaviour, kept so existing sealed keys keep
   * working. Set CC_WEB_SECRET_BOX_KEY (via index.ts) to separate the
   * two: rotating the JWT secret must then not break stored keys, and
   * a leaked JWT secret alone must not open them. Note that changing
   * this key makes keys sealed with the old key unreadable until they
   * are re-entered on the Profiles page.
   */
  secretBoxSecret?: Uint8Array;
};

/**
 * Report stored profile keys that the current secret cannot open (§18.1).
 *
 * The SecretBox key is derived from `CC_WEB_JWT_SECRET`, so rotating that
 * secret — or deploying with a different value than the one that sealed the
 * keys — makes every stored profile key unreadable. Without this the operator
 * discovers it one failed dispatch at a time, as `profile_key_unreadable`;
 * one boot-time warning lets them re-enter the keys before the first run.
 *
 * A legacy cleartext row (no `v1.` envelope) is skipped: the dispatch route
 * passes it through unchanged, so it still works and warning would send the
 * operator to re-enter a key that needs no fixing.
 */
export function warnUnreadableProfileKeys(
  db: Database,
  secretBox: SecretBox,
  warn: (message: string) => void,
): void {
  const rows = db
    .prepare(
      "SELECT name, api_key_encrypted FROM config_profiles WHERE api_key_encrypted IS NOT NULL",
    )
    .all() as Array<{ name: string; api_key_encrypted: string }>;
  const unreadable = rows.filter(
    (row) =>
      row.api_key_encrypted.startsWith("v1.") && secretBox.open(row.api_key_encrypted) === null,
  );
  if (unreadable.length === 0) return;
  warn(
    `control server: ${unreadable.length} stored profile API key(s) cannot be opened with ` +
      `the current sealing secret (CC_WEB_SECRET_BOX_KEY if set, otherwise CC_WEB_JWT_SECRET) ` +
      `(${unreadable.map((row) => row.name).join(", ")}). ` +
      "If the secret was rotated, re-enter those keys on the Profiles page.",
  );
}

export function buildServerOptions(config: ServerConfig): ServerOptions {
  const auth = new AuthService({ db: config.db, signer: createSigner(config.secret) });
  // §18.1, P3-C Task 5b: seal profile keys with a dedicated key when
  // one is configured, falling back to the JWT secret for compatibility.
  const secretBox = createSecretBox(config.secretBoxSecret ?? config.secret);
  warnUnreadableProfileKeys(config.db, secretBox, config.warn ?? console.warn);

  return {
    db: config.db,
    auth,
    allowedOrigins: config.allowedOrigins,
    ...(config.port === undefined ? {} : { port: config.port }),
    ...(config.attachmentsDir === undefined ? {} : { attachmentsDir: config.attachmentsDir }),
    secretBox,
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
