#!/usr/bin/env bun

/**
 * Runner daemon CLI entrypoint. Subcommands land here as phases progress:
 *   runner enroll  — one-time enrollment with a short-TTL token (§6.1)
 *   runner run     — start the daemon
 */

import { startDaemon } from "../daemon.ts";
import { enroll } from "../enrollment/enroll.ts";
import { saveIdentity } from "../identity/identity-store.ts";
import { runnerInfo } from "../index.ts";

const command = process.argv[2] ?? "run";

function identityDir(): string {
  return process.env["CC_WEB_RUNNER_HOME"] ?? `${process.env["HOME"]}/.cc-web-runner`;
}

/**
 * The enrollment token is read from stdin or `CC_WEB_ENROLL_TOKEN`, never argv.
 * A token in argv is a token in shell history and in `ps` for every user on the
 * host (§6.1).
 */
async function readEnrollToken(): Promise<string | undefined> {
  const fromEnv = process.env["CC_WEB_ENROLL_TOKEN"];
  if (fromEnv) return fromEnv;

  if (process.stdin.isTTY) {
    process.stderr.write("enrollment token: ");
    for await (const line of console) {
      const trimmed = line.trim();
      return trimmed === "" ? undefined : trimmed;
    }
    return undefined;
  }

  const piped = (await Bun.stdin.text()).trim();
  return piped === "" ? undefined : piped;
}

switch (command) {
  case "run": {
    const dir = identityDir();

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

  case "enroll": {
    const controlUrl = process.env["CC_WEB_CONTROL_URL"];
    if (!controlUrl) {
      console.error("enroll: CC_WEB_CONTROL_URL must be set");
      process.exit(1);
    }

    const token = await readEnrollToken();
    if (!token) {
      console.error("enroll: no token on stdin and CC_WEB_ENROLL_TOKEN is unset");
      process.exit(1);
    }

    const dir = identityDir();
    const result = await enroll({
      controlUrl,
      token,
      identityDir: dir,
      fetch,
      saveIdentity: (identity) => saveIdentity(dir, identity),
    });

    if (!result.ok) {
      // Deliberately no token in this message: it may be logged.
      console.error(result.message);
      process.exit(1);
    }

    console.log(`enrolled as ${result.identity.runnerId}`);
    console.log(`identity written to ${dir} (mode 0600)`);
    break;
  }

  default:
    console.error(`unknown command: ${command}`);
    process.exit(1);
}
