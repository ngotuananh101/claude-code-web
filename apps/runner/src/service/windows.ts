/**
 * Windows Task Scheduler service implementation for cc-web-runner.
 *
 * Windows console binaries do not implement Win32 Service Control Manager (SCM)
 * APIs directly, so `sc.exe` would fail with Error 1053.
 *
 * Instead, Windows Task Scheduler (`schtasks.exe`) provides standard, reliable
 * background daemon management on Windows:
 * - Starts automatically at user logon (`/SC ONLOGON`) or system startup (`/SC ONSTART`)
 * - Auto-restarts on failure (`<RestartOnFailure>`)
 * - Runs indefinitely on AC and battery power without a 72-hour execution limit (`PT0S`)
 * - Runs completely hidden without showing a console window on screen
 * - Redirects all daemon output (stdout & stderr) to a dedicated log file
 */

export const TASK_NAME = "cc-web-runner";

export type WindowsTaskOptions = {
  executablePath: string;
  homeDir: string;
  environmentFile?: string | undefined;
  /**
   * Carry the CLI-check hatch into the task's command line. Same reason as the
   * systemd unit: `service install --skip-cli-check` skips only the install-time
   * check, and the scheduled `connect` would otherwise re-run the gate.
   */
  skipCliCheck?: boolean | undefined;
  scope?: "system" | "user" | undefined;
  logDir?: string | undefined;
  logFile?: string | undefined;
};

export type WindowsTaskPaths = {
  homeDir: string;
  cmdPath: string;
  vbsPath: string;
  xmlPath: string;
  logDir: string;
  logPath: string;
};

export type WindowsTaskIo = {
  writeFile: (path: string, content: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  runCommand: (command: string, args: string[]) => Promise<void>;
  mkdir?: (path: string) => Promise<void>;
};

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function windowsTaskPaths(opts: WindowsTaskOptions): WindowsTaskPaths {
  const normHome = opts.homeDir.replaceAll("/", "\\");
  const normLogDir = opts.logDir ? opts.logDir.replaceAll("/", "\\") : `${normHome}\\logs`;
  const normLog = opts.logFile ? opts.logFile.replaceAll("/", "\\") : `${normLogDir}\\runner.log`;
  return {
    homeDir: normHome,
    cmdPath: `${normHome}\\run-runner.cmd`,
    vbsPath: `${normHome}\\run-runner.vbs`,
    xmlPath: `${normHome}\\cc-web-runner-task.xml`,
    logDir: normLogDir,
    logPath: normLog,
  };
}

/**
 * Generates the Windows command script that starts the runner daemon
 * and redirects all stdout and stderr output to the dedicated log file.
 */
export function renderRunnerCmd(opts: WindowsTaskOptions): string {
  const paths = windowsTaskPaths(opts);
  const argsList = ["connect", `--home "${paths.homeDir}"`, `--log-dir "${paths.logDir}"`];
  if (opts.skipCliCheck === true) argsList.push("--skip-cli-check");
  if (opts.environmentFile) {
    argsList.push(`--env-file "${opts.environmentFile.replaceAll("/", "\\")}"`);
  }
  const argsString = argsList.join(" ");

  return `@echo off\r\nif not exist "${paths.logDir}" mkdir "${paths.logDir}"\r\n"${opts.executablePath.replaceAll("/", "\\")}" ${argsString} >> "${paths.logPath}" 2>&1\r\n`;
}

/**
 * Generates a VBScript launcher that invokes the runner batch script with
 * window style 0 (SW_HIDE), ensuring no console or terminal window is created.
 */
export function renderRunnerVbs(cmdPath: string): string {
  const normCmd = cmdPath.replaceAll("/", "\\");
  return `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run "cmd.exe /c """ & "${normCmd}" & """", 0, True\r\n`;
}

export function renderWindowsTaskXml(opts: WindowsTaskOptions): string {
  const isSystem = opts.scope === "system";
  const paths = windowsTaskPaths(opts);

  const trigger = isSystem
    ? `<BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>`
    : `<LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>`;

  const principal = isSystem
    ? `<UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>`
    : `<LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>`;

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>cc-web runner daemon</Description>
    <URI>\\\\${TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    ${trigger}
  </Triggers>
  <Principals>
    <Principal id="Author">
      ${principal}
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>//nologo &quot;${escapeXml(paths.vbsPath)}&quot;</Arguments>
      <WorkingDirectory>${escapeXml(paths.homeDir || ".")}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** Installs and enables the Windows scheduled task using schtasks.exe. */
export async function installWindowsTask(
  opts: WindowsTaskOptions,
  io: WindowsTaskIo,
): Promise<WindowsTaskPaths> {
  const paths = windowsTaskPaths(opts);

  if (io.mkdir) {
    await io.mkdir(paths.homeDir);
    await io.mkdir(paths.logDir);
  }

  // 1. Write the runner batch script redirecting output to the log file
  const cmdContent = renderRunnerCmd(opts);
  await io.writeFile(paths.cmdPath, cmdContent);

  // 2. Write the VBScript launcher executing the script without a console window
  const vbsContent = renderRunnerVbs(paths.cmdPath);
  await io.writeFile(paths.vbsPath, vbsContent);

  // 3. Write the Windows Task definition XML
  const xmlContent = renderWindowsTaskXml(opts);
  await io.writeFile(paths.xmlPath, xmlContent);

  // 4. Ensure previous instance is stopped if running
  try {
    await io.runCommand("schtasks", ["/end", "/tn", TASK_NAME]);
  } catch {
    // If unit was not running, proceed
  }

  // 5. Register and run the scheduled task
  await io.runCommand("schtasks", ["/create", "/tn", TASK_NAME, "/xml", paths.xmlPath, "/f"]);
  await io.runCommand("schtasks", ["/run", "/tn", TASK_NAME]);

  return paths;
}

/** Stops and removes the Windows scheduled task and launcher files. */
export async function uninstallWindowsTask(
  io: WindowsTaskIo,
  opts?: { homeDir?: string },
): Promise<void> {
  try {
    await io.runCommand("schtasks", ["/end", "/tn", TASK_NAME]);
  } catch {
    // If unit was already stopped or does not exist, schtasks exits with non-zero.
  }

  await io.runCommand("schtasks", ["/delete", "/tn", TASK_NAME, "/f"]);

  if (opts?.homeDir) {
    const paths = windowsTaskPaths({ executablePath: "", homeDir: opts.homeDir });
    try {
      await io.removeFile(paths.xmlPath);
    } catch {
      // Proceed idempotently if file is already deleted.
    }
    try {
      await io.removeFile(paths.vbsPath);
    } catch {
      // Proceed idempotently if file is already deleted.
    }
    try {
      await io.removeFile(paths.cmdPath);
    } catch {
      // Proceed idempotently if file is already deleted.
    }
  }
}
