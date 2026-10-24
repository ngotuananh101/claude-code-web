#!/usr/bin/env bun

/**
 * Runner daemon CLI entrypoint. Subcommands land here as phases progress:
 *   runner run — start the daemon
 */

import { startDaemon } from "../daemon.ts";
import { runnerInfo } from "../index.ts";

const command = process.argv[2] ?? "run";

switch (command) {
  case "run": {
    const dir = process.env["CC_WEB_RUNNER_HOME"] ?? `${process.env["HOME"]}/.cc-web-runner`;

    const daemon = await startDaemon({
      identityDir: dir,
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
      // Waits for in-flight runs: closing the database underneath one would
      // lose its events and leave its workspace locked.
      void daemon.stop().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    break;
  }

  default:
    console.error(`unknown command: ${command}`);
    process.exit(1);
}
