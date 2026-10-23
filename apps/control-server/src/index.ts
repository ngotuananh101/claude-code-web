/**
 * Control Server entrypoint — Bun + Hono-shaped routing over `Bun.serve`.
 *
 * Owns web auth, runner registry, scheduling, command outbox, event ingestion
 * and projections. Never touches a Runner filesystem directly (§3.1, §3.2).
 *
 * This file is deliberately thin: it reads configuration, opens the database,
 * and hands everything to `createServer`. Configuration that is missing or weak
 * fails at startup rather than on the first request.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "@cc-web/control-db";
import { PROTOCOL_VERSION } from "@cc-web/protocol";
import { AuthService } from "./auth/auth-service.ts";
import { createSigner } from "./auth/tokens.ts";
import { createServer } from "./server.ts";

export const serverInfo = {
  name: "cc-web-control-server",
  protocolVersion: PROTOCOL_VERSION,
} as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Failing here beats failing on the first login with a confusing 500.
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

function main(): void {
  const dbPath = process.env["CC_WEB_DB"] ?? "./data/control.sqlite";
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  migrate(db);

  // The signing secret is read as raw bytes; a short one is rejected by
  // `createSigner` rather than silently weakening every token.
  const secret = new TextEncoder().encode(requireEnv("CC_WEB_JWT_SECRET"));
  const allowedOrigins = (process.env["CC_WEB_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");

  if (allowedOrigins.length === 0) {
    // §19.1 requires an Origin allowlist before the browser upgrade. Starting
    // without one would mean every socket upgrade is refused at runtime, which
    // looks like a bug rather than a misconfiguration.
    throw new Error("CC_WEB_ALLOWED_ORIGINS must list at least one origin");
  }

  const auth = new AuthService({ db, signer: createSigner(secret) });

  const handle = createServer({
    db,
    auth,
    allowedOrigins,
    // Runner credential verification against the hashed secrets in the DB is
    // wired in the next step; until then no runner can authenticate.
    verifyRunnerCredential: () => ({ ok: false, reason: "unknown" }),
  });

  console.log(
    `${serverInfo.name} listening on :${handle.server.port} (protocol v${PROTOCOL_VERSION})`,
  );

  const shutdown = () => {
    handle.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  main();
}
