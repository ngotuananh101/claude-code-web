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
import { buildServerOptions } from "./config.ts";
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

  // The session-signing secret. better-auth uses it for cookie signing and
  // encryption; a short one weakens every session, so the length floor is
  // enforced here rather than hoping the operator read the docs.
  const secret = requireEnv("BETTER_AUTH_SECRET");
  if (secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  }

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

  // Fixed by default so the vite dev proxy has a stable upstream; 0 would
  // pick a random port and turn every restart into a config edit.
  const port = Number(process.env["CC_WEB_PORT"] ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`CC_WEB_PORT must be an integer between 0 and 65535, got: ${port}`);
  }

  // Canonical origin better-auth validates cookies and redirects against;
  // defaulting to the dev upstream keeps the common local setup one-variable.
  const baseURL = process.env["BETTER_AUTH_URL"] ?? `http://localhost:${port}`;

  const handle = createServer(buildServerOptions({ db, baseURL, secret, allowedOrigins, port }));

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
