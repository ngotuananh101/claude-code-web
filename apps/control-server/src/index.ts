/**
 * Control Server entrypoint — Bun + Hono.
 *
 * Owns web auth, runner registry, scheduling, command outbox, event ingestion
 * and projections. Never touches a Runner filesystem directly (§3.1, §3.2).
 */

import { PROTOCOL_VERSION } from "@cc-web/protocol";

export const serverInfo = {
  name: "cc-web-control-server",
  protocolVersion: PROTOCOL_VERSION,
} as const;
