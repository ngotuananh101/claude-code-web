/**
 * The systemd unit for the connector (§6.1, cloudflared-style).
 *
 * `renderSystemdUnit` is pure text with no secret in it — the token lives only
 * in the 0600 identity file under CC_WEB_RUNNER_HOME — so the unit can be
 * written to /etc/systemd/system or ~/.config/systemd/user freely and
 * `service print` needs no privileges. The mutating paths take an injected io
 * so tests never touch systemctl or the filesystem.
 */

export const UNIT_NAME = "cc-web-runner.service";
export const SYSTEM_UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}`;
/** Legacy alias for backward compatibility. */
export const UNIT_PATH = SYSTEM_UNIT_PATH;

export type UnitScope = "system" | "user";

export type UnitOptions = {
  /** The executable to run; rendered into ExecStart with the `connect` verb. */
  executablePath: string;
  /** Where the 0600 identity lives; passed through the environment. */
  homeDir: string;
  /** Optional env file, referenced by path only. */
  environmentFile?: string | undefined;
  /**
   * System service target user (only rendered for system scope).
   * Defaults to "root" when scope is "system" and user is omitted.
   * Not rendered when scope is "user".
   */
  user?: string | undefined;
  /** Whether this unit is for system-wide or per-user systemd. Defaults to "system". */
  scope?: UnitScope | undefined;
};

export function userUnitPath(homeDir?: string): string {
  if (homeDir) {
    const baseHome = homeDir.endsWith("/.cc-web-runner")
      ? homeDir.slice(0, -"/.cc-web-runner".length)
      : homeDir;
    return `${baseHome}/.config/systemd/user/${UNIT_NAME}`;
  }
  const configHome = process.env["XDG_CONFIG_HOME"] ?? `${process.env["HOME"]}/.config`;
  return `${configHome}/systemd/user/${UNIT_NAME}`;
}

export function renderSystemdUnit(opts: UnitOptions): string {
  const envFile =
    opts.environmentFile === undefined ? "" : `EnvironmentFile=${opts.environmentFile}\n`;
  const isUserScope = opts.scope === "user";

  if (isUserScope) {
    return `[Unit]
Description=cc-web runner daemon
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${opts.executablePath} connect
Environment=CC_WEB_RUNNER_HOME=${opts.homeDir}
${envFile}Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  }

  const userLine = `User=${opts.user ?? "root"}\n`;

  return `[Unit]
Description=cc-web runner daemon
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${opts.executablePath} connect
Environment=CC_WEB_RUNNER_HOME=${opts.homeDir}
${envFile}Restart=on-failure
RestartSec=5
${userLine}
[Install]
WantedBy=multi-user.target
`;
}

export type SystemdIo = {
  writeFile: (path: string, content: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  runCommand: (command: string, args: string[]) => Promise<void>;
  mkdir?: (path: string) => Promise<void>;
};

/** Unit file first, then reload, then enable: order matters. */
export async function writeUnitAndEnable(opts: UnitOptions, io: SystemdIo): Promise<string> {
  const isUser = opts.scope === "user";
  const unitPath = isUser ? userUnitPath(opts.homeDir) : SYSTEM_UNIT_PATH;

  if (isUser && io.mkdir) {
    const dir = unitPath.slice(0, unitPath.lastIndexOf("/"));
    await io.mkdir(dir);
  }

  await io.writeFile(unitPath, renderSystemdUnit(opts));

  const systemctlArgs = isUser ? ["--user"] : [];
  await io.runCommand("systemctl", [...systemctlArgs, "daemon-reload"]);
  await io.runCommand("systemctl", [...systemctlArgs, "enable", "--now", UNIT_NAME]);
  return unitPath;
}

/** Stop before removing: a running process with no unit behind it is worse. */
export async function stopAndDisable(
  io: SystemdIo,
  opts?: { scope?: UnitScope; homeDir?: string },
): Promise<string> {
  const isUser = opts?.scope === "user";
  const unitPath = isUser ? userUnitPath(opts?.homeDir) : SYSTEM_UNIT_PATH;

  const systemctlArgs = isUser ? ["--user"] : [];
  try {
    await io.runCommand("systemctl", [...systemctlArgs, "disable", "--now", UNIT_NAME]);
  } catch {
    // If unit was already disabled or does not exist, systemctl exits with non-zero.
    // Proceed idempotently to remove the unit file so cleanup always finishes.
  }
  await io.removeFile(unitPath);
  return unitPath;
}
