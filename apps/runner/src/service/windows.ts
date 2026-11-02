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
 * - Runs hidden without keeping a console window open
 */

export const TASK_NAME = "cc-web-runner";

export type WindowsTaskOptions = {
  executablePath: string;
  homeDir: string;
  environmentFile?: string | undefined;
  scope?: "system" | "user" | undefined;
};

export type WindowsTaskIo = {
  writeFile: (path: string, content: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  runCommand: (command: string, args: string[]) => Promise<void>;
};

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderWindowsTaskXml(opts: WindowsTaskOptions): string {
  const isSystem = opts.scope === "system";

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

  const argsList = ["connect"];
  if (opts.homeDir) {
    argsList.push(`--home "${opts.homeDir}"`);
  }
  if (opts.environmentFile) {
    argsList.push(`--env-file "${opts.environmentFile}"`);
  }
  const argsString = argsList.join(" ");

  const workingDir = opts.homeDir || ".";

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
      <Command>${escapeXml(opts.executablePath)}</Command>
      <Arguments>${escapeXml(argsString)}</Arguments>
      <WorkingDirectory>${escapeXml(workingDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** Installs and enables the Windows scheduled task using schtasks.exe. */
export async function installWindowsTask(
  opts: WindowsTaskOptions,
  io: WindowsTaskIo,
): Promise<string> {
  const xmlContent = renderWindowsTaskXml(opts);
  const xmlPath = `${opts.homeDir}/cc-web-runner-task.xml`;

  await io.writeFile(xmlPath, xmlContent);
  await io.runCommand("schtasks", ["/create", "/tn", TASK_NAME, "/xml", xmlPath, "/f"]);
  await io.runCommand("schtasks", ["/run", "/tn", TASK_NAME]);

  return xmlPath;
}

/** Stops and removes the Windows scheduled task. */
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
    const xmlPath = `${opts.homeDir}/cc-web-runner-task.xml`;
    try {
      await io.removeFile(xmlPath);
    } catch {
      // Proceed idempotently if file is already deleted.
    }
  }
}
