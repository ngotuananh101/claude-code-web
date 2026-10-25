#!/usr/bin/env bun

/**
 * Runner connector CLI. Cloudflared-shaped: one binary, a web-minted token,
 * a service install.
 *
 *   runner setup <options>   store the identity once (token via env/TTY/stdin)
 *   runner connect           start the daemon (run is an alias)
 *   runner service print     write the systemd unit to stdout
 *   runner service install   install + enable the systemd unit (root)
 *   runner service uninstall stop, disable and remove the unit (root)
 */

import { rm, writeFile } from "node:fs/promises";
import { startDaemon } from "../daemon.ts";
import { saveIdentity } from "../identity/identity-store.ts";
import { runnerInfo } from "../index.ts";
import {
  renderSystemdUnit,
  type SystemdIo,
  stopAndDisable,
  UNIT_NAME,
  writeUnitAndEnable,
} from "../service/systemd.ts";
import { resolveServerUrl, runSetup } from "../setup/setup.ts";
import { defaultWorkspaceResolver } from "../workspaces.ts";

/**
 * The server origin baked in at compile time by the release workflow
 * (--define CC_WEB_DEFAULT_SERVER:"https://…"). Undefined in dev and in
 * plain `bun run build:runner`, where setup asks for --server as usual —
 * the typeof guard keeps the unbuilt reference from throwing.
 */
declare const CC_WEB_DEFAULT_SERVER: string | undefined;

const bakedServerUrl =
  typeof CC_WEB_DEFAULT_SERVER === "string" ? CC_WEB_DEFAULT_SERVER : undefined;

const USAGE = `${runnerInfo.name}

usage:
  runner setup --server <http(s) origin> --runner-id <id>   token: CC_WEB_RUNNER_TOKEN | TTY | stdin
  runner connect
  runner service install | uninstall | print`;

const command = process.argv[2] ?? "connect";

function identityDir(): string {
  return process.env["CC_WEB_RUNNER_HOME"] ?? `${process.env["HOME"]}/.cc-web-runner`;
}

/** The real io for the service subcommands; systemd is actually run. */
function realSystemdIo(): SystemdIo {
  return {
    writeFile,
    removeFile: (path) => rm(path, { force: true }),
    runCommand: (command, args) =>
      new Promise((resolve, reject) => {
        const proc = Bun.spawnSync([command, ...args]);
        if (proc.exitCode !== 0) {
          reject(new Error(`${command} ${args.join(" ")} failed (exit ${proc.exitCode})`));
          return;
        }
        resolve();
      }),
  };
}

/**
 * The token is read from env, a TTY prompt, or piped stdin — never argv. A
 * token in argv lands in shell history and in `ps` for every user on the
 * host (§19.4).
 */
async function readRunnerToken(): Promise<string | undefined> {
  const fromEnv = process.env["CC_WEB_RUNNER_TOKEN"];
  if (fromEnv) return fromEnv;

  if (process.stdin.isTTY) {
    process.stderr.write("runner token: ");
    for await (const line of console) {
      const trimmed = line.trim();
      return trimmed === "" ? undefined : trimmed;
    }
    return undefined;
  }

  const piped = (await Bun.stdin.text()).trim();
  return piped === "" ? undefined : piped;
}

/** Parsed `--key value` options; keys and values are not secrets. */
function parseOptions(argv: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i]!.startsWith("--")) options[argv[i]!.slice(2)] = argv[i + 1]!;
  }
  return options;
}

/**
 * The compiled binary's execPath is the executable itself; under `bun run`
 * the script file must ride along for the unit's ExecStart to work.
 */
function executablePath(): string {
  const script = process.argv[1] ?? "";
  return script.endsWith(".ts") ? `${process.execPath} ${script}` : process.execPath;
}

async function start(): Promise<void> {
  const dir = identityDir();

  const daemon = await startDaemon({
    identityDir: dir,
    runnerVersion: "0.0.0",
    sdkVersion: "0.3.309",
    // §11.1 MVP: one directory named in the environment serves the default
    // workspace until the registration surface exists.
    workspacePathFor: defaultWorkspaceResolver(process.env["CC_WEB_RUNNER_DEFAULT_WORKSPACE"]),
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
}

switch (command) {
  case "connect":
  case "run": {
    await start();
    break;
  }

  case "setup": {
    const options = parseOptions(process.argv.slice(3));
    const token = await readRunnerToken();

    const result = await runSetup(
      {
        serverUrl: resolveServerUrl(options["server"], bakedServerUrl),
        runnerId: options["runner-id"] ?? "",
        token,
        identityDir: identityDir(),
      },
      { saveIdentity },
    );

    if (!result.ok) {
      // Deliberately no token in this message: it may be logged.
      console.error(result.message);
      process.exit(1);
    }

    const dir = identityDir();
    console.log(`identity written to ${dir} (mode 0600)`);
    console.log(`connecting to ${result.controlUrl}`);
    console.log("next: cc-web-runner connect   (or: cc-web-runner service install)");
    break;
  }

  case "service": {
    const sub = process.argv[3];

    if (sub === "print") {
      process.stdout.write(
        renderSystemdUnit({ executablePath: executablePath(), homeDir: identityDir() }),
      );
      break;
    }

    if (sub === "install") {
      const environmentFile = process.env["CC_WEB_RUNNER_ENV_FILE"];
      await writeUnitAndEnable(
        {
          executablePath: executablePath(),
          homeDir: identityDir(),
          ...(environmentFile === undefined ? {} : { environmentFile }),
        },
        realSystemdIo(),
      );
      console.log(`installed and enabled ${UNIT_NAME}`);
      console.log("next: systemctl status cc-web-runner.service");
      break;
    }

    if (sub === "uninstall") {
      await stopAndDisable(realSystemdIo());
      console.log("stopped, disabled and removed cc-web-runner.service");
      break;
    }

    console.error(`service: unknown subcommand ${sub ?? "(none)"} (install | uninstall | print)`);
    process.exit(1);
    break;
  }

  default:
    console.error(`unknown command: ${command}`);
    console.error(USAGE);
    process.exit(1);
}
