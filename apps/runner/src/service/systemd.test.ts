import { describe, expect, test } from "bun:test";
import {
  renderSystemdUnit,
  stopAndDisable,
  UNIT_NAME,
  UNIT_PATH,
  writeUnitAndEnable,
} from "./systemd.ts";

/**
 * The systemd unit (§6.1): the connector runs as a service the way cloudflared
 * does. The unit is pure text with no secret in it — the token lives only in
 * the 0600 identity file under CC_WEB_RUNNER_HOME — so writing it to
 * /etc/systemd/system is safe and `service print` needs no privileges.
 */

const unit = renderSystemdUnit({
  executablePath: "/usr/local/bin/cc-web-runner",
  homeDir: "/var/lib/cc-web-runner",
});

describe("renderSystemdUnit", () => {
  test("starts the connector subcommand under the runner home", () => {
    expect(unit).toContain("ExecStart=/usr/local/bin/cc-web-runner connect");
    expect(unit).toContain("Environment=CC_WEB_RUNNER_HOME=/var/lib/cc-web-runner");
  });

  test("survives failures and comes back after boot", () => {
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=5");
    expect(unit).toContain("After=network-online.target");
    expect(unit).toContain("WantedBy=multi-user.target");
  });

  test("carries no secret material", () => {
    // No token parameter exists on the function; the unit must not grow one.
    expect(unit).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(unit).not.toMatch(/^Environment=.*TOKEN=/m);
  });

  test("an environment file is referenced by path only", () => {
    const withEnv = renderSystemdUnit({
      executablePath: "/usr/local/bin/cc-web-runner",
      homeDir: "/var/lib/cc-web-runner",
      environmentFile: "/etc/cc-web-runner.env",
    });

    expect(withEnv).toContain("EnvironmentFile=/etc/cc-web-runner.env");
    // The file's contents are the operator's business; the unit only names it.
    expect(
      withEnv
        .split("\n")
        .every(
          (line) =>
            !line.startsWith("EnvironmentFile=") ||
            line === "EnvironmentFile=/etc/cc-web-runner.env",
        ),
    ).toBe(true);
  });
});

describe("writeUnitAndEnable", () => {
  test("writes the unit, reloads the daemon and enables the service", async () => {
    const calls: Array<{ kind: string; target: string; args?: string[] }> = [];
    const io = {
      writeFile: async (path: string) => {
        calls.push({ kind: "write", target: path });
      },
      removeFile: async (path: string) => {
        calls.push({ kind: "remove", target: path });
      },
      runCommand: async (command: string, args: string[]) => {
        calls.push({ kind: "run", target: command, args });
      },
    };

    await writeUnitAndEnable(
      { executablePath: "/usr/local/bin/cc-web-runner", homeDir: "/var/lib/cc-web-runner" },
      io,
    );

    // Unit first, then reload, then enable: a reload before the file exists
    // would enable a service systemd cannot find yet.
    expect(calls[0]).toEqual({ kind: "write", target: UNIT_PATH });
    expect(calls[1]).toEqual({ kind: "run", target: "systemctl", args: ["daemon-reload"] });
    expect(calls[2]).toEqual({
      kind: "run",
      target: "systemctl",
      args: ["enable", "--now", UNIT_NAME],
    });
    expect(UNIT_NAME).toBe("cc-web-runner.service");
  });
});

describe("stopAndDisable", () => {
  test("disables the service and removes the unit file", async () => {
    const calls: Array<{ kind: string; target: string; args?: string[] }> = [];
    const io = {
      writeFile: async (path: string) => {
        calls.push({ kind: "write", target: path });
      },
      removeFile: async (path: string) => {
        calls.push({ kind: "remove", target: path });
      },
      runCommand: async (command: string, args: string[]) => {
        calls.push({ kind: "run", target: command, args });
      },
    };

    await stopAndDisable(io);

    // Stop first: removing the unit while the service runs leaves a running
    // process with no definition behind it.
    expect(calls[0]).toEqual({
      kind: "run",
      target: "systemctl",
      args: ["disable", "--now", UNIT_NAME],
    });
    expect(calls[1]).toEqual({ kind: "remove", target: UNIT_PATH });
  });
});
