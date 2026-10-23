#!/usr/bin/env bun
/**
 * Runner daemon CLI entrypoint. Subcommands land here as phases progress:
 *   runner enroll  — one-time enrollment with a short-TTL token (§6.1)
 *   runner run     — start the daemon
 */

import { runnerInfo } from "../index.ts";
import { startDaemon } from "../daemon.ts";

const command = process.argv[2] ?? "run";

switch (command) {
  case "run": {
    const identityDir = process.env["CC_WEB_RUNNER_HOME"] ?? `${process.env["HOME"]}/.cc-web-runner`;

    const daemon = await startDaemon({
      identityDir,
      runnerVersion: "0.0.0",
      sdkVersion: "0.3.309",
      onEvent: (event) => {
        // Connection lifecycle only. Never log the credential, and never log
        // command payloads — they can contain prompt text (§19.4).
        console.log(JSON.stringify(event));
      },
    });

    console.log(`${runnerInfo.name} ready (runner ${daemon.identity.runnerId})`);

    const shutdown = () => {
      daemon.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    break;
  }

  case "enroll":
    console.error("enroll: not implemented yet");
    process.exit(1);
    break;

  default:
    console.error(`unknown command: ${command}`);
    process.exit(1);
}
