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

import { Database } from "bun:sqlite";
import { execSync } from "node:child_process";
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { migrateRunnerDb } from "@cc-web/runner-db";
import { startDaemon } from "../daemon.ts";
import { discoverModels } from "../execution/model-catalog.ts";
import { currentBranch, listBranches } from "../git/branches.ts";
import { saveIdentity } from "../identity/identity-store.ts";
import { runnerInfo } from "../index.ts";
import {
  renderSystemdUnit,
  type SystemdIo,
  stopAndDisable,
  UNIT_NAME,
  type UnitScope,
  writeUnitAndEnable,
} from "../service/systemd.ts";
import { resolveServerUrl, runSetup } from "../setup/setup.ts";
import { createWorkspaceRegistry } from "../workspaces/registry.ts";

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
  runner service install [--scope user|system] [--user <name>] [--home <path>]
  runner service uninstall [--scope user|system]
  runner service print [--scope user|system] [--user <name>] [--home <path>]`;

const command = process.argv[2] ?? "connect";

function identityDir(): string {
  return process.env["CC_WEB_RUNNER_HOME"] ?? `${process.env["HOME"]}/.cc-web-runner`;
}

/**
 * Resolves whether the systemd service target is user or system scope.
 * When invoked by a regular user without sudo, defaults to "user" scope so
 * installation requires no root privileges and places the unit under ~/.config/systemd/user.
 * When invoked by root or under sudo, defaults to "system" scope.
 */
function resolveScope(options: Record<string, string>): UnitScope {
  if (options["scope"] === "user" || options["user"] === "true") return "user";
  if (options["scope"] === "system" || options["system"] === "true") return "system";
  const isRoot = typeof process.getuid === "function" ? process.getuid() === 0 : false;
  return isRoot ? "system" : "user";
}

/**
 * Resolves the target OS user for the systemd service.
 * When installed under sudo, prefers SUDO_USER so the runner service inherits
 * the invoking user's environment, home directory, and toolchains (§6.1, ADR-014).
 */
function resolveTargetUser(options: Record<string, string>): string | undefined {
  if (options["user"] && options["user"] !== "true") return options["user"];
  const sudoUser = process.env["SUDO_USER"];
  if (sudoUser && sudoUser !== "root") return sudoUser;
  const currentUser = process.env["USER"] ?? process.env["LOGNAME"];
  if (currentUser && currentUser !== "root") return currentUser;
  return undefined;
}

/**
 * Resolves a username's home directory across standard Linux environments.
 */
function resolveUserHome(username: string): string | undefined {
  try {
    const entry = execSync(`getent passwd ${username}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parts = entry.trim().split(":");
    if (parts[5]) return parts[5];
  } catch {
    // fallback if getent fails or is missing
  }
  if (process.platform === "linux" && username) {
    return `/home/${username}`;
  }
  return undefined;
}

/**
 * Resolves the runner's home directory. If running under sudo or targeting a user,
 * points to that user's ~/.cc-web-runner where identity.json was initialized.
 */
function resolveServiceHome(
  targetUser: string | undefined,
  options: Record<string, string>,
): string {
  if (options["home"]) return options["home"];
  if (process.env["CC_WEB_RUNNER_HOME"]) return process.env["CC_WEB_RUNNER_HOME"];
  if (targetUser && targetUser !== "root") {
    const userHome = resolveUserHome(targetUser);
    if (userHome) return `${userHome}/.cc-web-runner`;
  }
  return identityDir();
}

/**
 * Opens the runner database for workspace discovery. The daemon opens its own
 * handle later; this one is read-only and closed after discovery so two
 * processes never contend on the same SQLite handle. Migrations are applied
 * idempotently so a first boot discovers custom workspaces from a fresh schema.
 */
function openRunnerDb(dir: string): Database {
  const db = new Database(`${dir}/runner.db`);
  migrateRunnerDb(db);
  return db;
}

/** The real io for the service subcommands; systemd is actually run. */
function realSystemdIo(): SystemdIo {
  return {
    writeFile,
    removeFile: (path) => rm(path, { force: true }),
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
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

/** Parsed `--key value` and boolean `--flag` options; keys and values are not secrets. */
function parseOptions(argv: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        options[key] = next;
        i += 1;
      } else {
        options[key] = "true";
      }
    }
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
  const defaultWorkspaceEnv = process.env["CC_WEB_RUNNER_DEFAULT_WORKSPACE"];

  // §11.1 / §18.2: discover all workspaces — the default env dir, any persisted
  // custom workspaces in the runner db, and Claude Code projects under the home
  // directory. The declared list and the resolver both derive from this single
  // registry, so they cannot disagree (§15.1).
  //
  // The db handle is opened once here so the thunk doesn't leak a handle per
  // reconnect; the daemon opens its own handle for its read-write inbox/outbox
  // and writes to the same file, which SQLite supports concurrently for reads
  // from this handle.
  const db = openRunnerDb(dir);
  // The registry caches discovery (every hello, reconcile and command lookup
  // would otherwise rescan the disk) and refreshes it when a custom workspace
  // is persisted — the run controller does that for the first `run.start` in a
  // freshly browsed folder, and the handlers after it must see the id.
  const registry = createWorkspaceRegistry({
    ...(defaultWorkspaceEnv === undefined ? {} : { defaultEnv: defaultWorkspaceEnv }),
    db,
    ...(process.env["HOME"] === undefined ? {} : { homeDir: process.env["HOME"] }),
  });

  // §5.2: ask this host's Claude Code which models it offers — custom names
  // included. Bounded and best-effort (never rejects): a probe that cannot
  // answer just means the composer falls back to the protocol's own list.
  const models = await discoverModels({
    cwd: defaultWorkspaceEnv ?? process.env["HOME"] ?? process.cwd(),
  });
  console.log(
    `discovered ${models.length} model${models.length === 1 ? "" : "s"}: ${models
      .map((model) => model.value)
      .join(", ")}`,
  );

  const daemon = await startDaemon({
    identityDir: dir,
    runnerVersion: "0.0.0",
    sdkVersion: "0.3.309",
    models,
    workspacePathFor: (workspaceId) => registry.pathFor(workspaceId),
    declaredWorkspaces: () =>
      registry.list().map((workspace) => {
        const head = currentBranch(workspace.path);
        return {
          ...workspace,
          branches: listBranches(workspace.path),
          ...(head === undefined ? {} : { currentBranch: head }),
        };
      }),
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
  case "-h":
  case "--help":
  case "help": {
    console.log(USAGE);
    break;
  }

  case "-v":
  case "--version":
  case "version": {
    console.log(`${runnerInfo.name} (protocol v${runnerInfo.protocolVersion})`);
    break;
  }

  case "connect":
  case "run": {
    await start();
    break;
  }

  case "setup": {
    const rawArgs = process.argv.slice(3);
    if (rawArgs.includes("-h") || rawArgs.includes("--help") || rawArgs.includes("help")) {
      console.log(
        "usage: runner setup --server <http(s) origin> --runner-id <id>   token: CC_WEB_RUNNER_TOKEN | TTY | stdin",
      );
      break;
    }

    const options = parseOptions(rawArgs);
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
    if (sub === "-h" || sub === "--help" || sub === "help" || sub === undefined) {
      console.log(
        "usage: runner service install | uninstall | print [--scope user|system] [--user <name>] [--home <path>]",
      );
      break;
    }

    const options = parseOptions(process.argv.slice(4));
    const scope: UnitScope = resolveScope(options);
    const targetUser = scope === "user" ? undefined : resolveTargetUser(options);
    const home = resolveServiceHome(targetUser, options);

    if (sub === "print") {
      process.stdout.write(
        renderSystemdUnit({
          executablePath: executablePath(),
          homeDir: home,
          user: targetUser,
          scope,
          environmentFile: process.env["CC_WEB_RUNNER_ENV_FILE"] ?? options["env-file"],
        }),
      );
      break;
    }

    if (sub === "install") {
      if (scope === "system" && typeof process.getuid === "function" && process.getuid() !== 0) {
        console.error("error: installing a system service requires root permissions.");
        console.error("  Run with sudo: sudo ./cc-web-runner service install --scope system");
        console.error("  Or install as user service without sudo: ./cc-web-runner service install");
        process.exit(1);
      }

      let execPath = executablePath();
      const script = process.argv[1] ?? "";
      const isCompiled = !script.endsWith(".ts");
      const SYSTEM_BIN_PATH = "/usr/local/bin/cc-web-runner";

      // For system-scoped installations from a compiled binary, install into /usr/local/bin
      // so systemd (under SELinux init_t) can execute it without user-directory denials (§6.1).
      if (scope === "system" && isCompiled && process.execPath !== SYSTEM_BIN_PATH) {
        try {
          await copyFile(process.execPath, SYSTEM_BIN_PATH);
          await chmod(SYSTEM_BIN_PATH, 0o755);
          execPath = SYSTEM_BIN_PATH;
          console.log(`installed runner binary to ${SYSTEM_BIN_PATH}`);
        } catch (err) {
          console.warn(`warning: could not copy runner to ${SYSTEM_BIN_PATH}: ${err}`);
        }
      }

      const environmentFile = process.env["CC_WEB_RUNNER_ENV_FILE"] ?? options["env-file"];
      const installedPath = await writeUnitAndEnable(
        {
          executablePath: execPath,
          homeDir: home,
          user: targetUser,
          scope,
          ...(environmentFile === undefined ? {} : { environmentFile }),
        },
        realSystemdIo(),
      );

      const userNote = targetUser ? ` (user: ${targetUser})` : "";
      const scopeNote = scope === "user" ? " (user unit)" : "";
      console.log(`installed and enabled ${UNIT_NAME}${userNote}${scopeNote} at ${installedPath}`);
      const statusCmd =
        scope === "user"
          ? "systemctl --user status cc-web-runner.service"
          : "systemctl status cc-web-runner.service";
      console.log(`next: ${statusCmd}`);
      break;
    }

    if (sub === "uninstall") {
      if (scope === "system" && typeof process.getuid === "function" && process.getuid() !== 0) {
        console.error("error: uninstalling a system service requires root permissions.");
        console.error("  Run with sudo: sudo ./cc-web-runner service uninstall --scope system");
        console.error(
          "  Or uninstall user service without sudo: ./cc-web-runner service uninstall",
        );
        process.exit(1);
      }

      const uninstalledPath = await stopAndDisable(realSystemdIo(), {
        scope,
        homeDir: home,
      });
      console.log(`stopped, disabled and removed ${UNIT_NAME} (${uninstalledPath})`);
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
