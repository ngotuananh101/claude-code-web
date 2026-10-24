/**
 * The systemd unit for the connector (§6.1, cloudflared-style).
 *
 * `renderSystemdUnit` is pure text with no secret in it — the token lives only
 * in the 0600 identity file under CC_WEB_RUNNER_HOME — so the unit can be
 * written to /etc/systemd/system freely and `service print` needs no
 * privileges. The mutating paths take an injected io so tests never touch
 * systemctl or the filesystem.
 */

export const UNIT_NAME = "cc-web-runner.service";
export const UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}`;

export type UnitOptions = {
  /** The executable to run; rendered into ExecStart with the `connect` verb. */
  executablePath: string;
  /** Where the 0600 identity lives; passed through the environment. */
  homeDir: string;
  /** Optional env file, referenced by path only. */
  environmentFile?: string | undefined;
};

export function renderSystemdUnit(opts: UnitOptions): string {
  const envFile =
    opts.environmentFile === undefined ? "" : `EnvironmentFile=${opts.environmentFile}\n`;

  return `[Unit]
Description=cc-web runner daemon
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${opts.executablePath} connect
Environment=CC_WEB_RUNNER_HOME=${opts.homeDir}
${envFile}Restart=on-failure
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
`;
}

export type SystemdIo = {
  writeFile: (path: string, content: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  runCommand: (command: string, args: string[]) => Promise<void>;
};

/** Unit file first, then reload, then enable: order matters. */
export async function writeUnitAndEnable(opts: UnitOptions, io: SystemdIo): Promise<void> {
  await io.writeFile(UNIT_PATH, renderSystemdUnit(opts));
  await io.runCommand("systemctl", ["daemon-reload"]);
  await io.runCommand("systemctl", ["enable", "--now", UNIT_NAME]);
}

/** Stop before removing: a running process with no unit behind it is worse. */
export async function stopAndDisable(io: SystemdIo): Promise<void> {
  await io.runCommand("systemctl", ["disable", "--now", UNIT_NAME]);
  await io.removeFile(UNIT_PATH);
}
