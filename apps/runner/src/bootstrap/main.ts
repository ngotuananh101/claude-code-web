#!/usr/bin/env bun
/**
 * Runner daemon CLI entrypoint. Subcommands land here as phases progress:
 *   runner enroll  — one-time enrollment with a short-TTL token (§6.1)
 *   runner run     — start the daemon
 */

import { runnerInfo } from "../index.ts";

const command = process.argv[2] ?? "run";

switch (command) {
  case "run":
    console.log(`${runnerInfo.name} starting (protocol v${runnerInfo.protocolVersion})`);
    // TODO(Phase 1): bootstrap identity → connection loop → reconcile → ready
    break;
  case "enroll":
    console.error("enroll: not implemented yet (Phase 1)");
    process.exit(1);
    break;
  default:
    console.error(`unknown command: ${command}`);
    process.exit(1);
}
