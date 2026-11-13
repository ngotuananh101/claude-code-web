import { describe, expect, test } from "bun:test";
import {
  installWindowsTask,
  renderRunnerCmd,
  renderRunnerVbs,
  renderWindowsTaskXml,
  TASK_NAME,
  uninstallWindowsTask,
  windowsTaskPaths,
} from "./windows.ts";

const sampleOpts = {
  executablePath: "C:\\Program Files\\cc-web-runner\\cc-web-runner-windows-x64.exe",
  homeDir: "C:\\Users\\User\\.cc-web-runner",
};

const userTask = renderWindowsTaskXml(sampleOpts);

describe("windowsTaskPaths", () => {
  test("normalizes backslashes and derives cmd, vbs, xml, logDir, and log paths", () => {
    const paths = windowsTaskPaths({
      executablePath: "C:/bin/runner.exe",
      homeDir: "C:/Users/User/.cc-web-runner",
    });

    expect(paths.homeDir).toBe("C:\\Users\\User\\.cc-web-runner");
    expect(paths.cmdPath).toBe("C:\\Users\\User\\.cc-web-runner\\run-runner.cmd");
    expect(paths.vbsPath).toBe("C:\\Users\\User\\.cc-web-runner\\run-runner.vbs");
    expect(paths.xmlPath).toBe("C:\\Users\\User\\.cc-web-runner\\cc-web-runner-task.xml");
    expect(paths.logDir).toBe("C:\\Users\\User\\.cc-web-runner\\logs");
    expect(paths.logPath).toBe("C:\\Users\\User\\.cc-web-runner\\logs\\runner.log");
  });

  test("uses custom log dir and log file path when specified", () => {
    const paths = windowsTaskPaths({
      executablePath: "C:\\runner.exe",
      homeDir: "C:\\home",
      logDir: "D:/runner-logs",
      logFile: "D:/runner-logs/custom.log",
    });

    expect(paths.logDir).toBe("D:\\runner-logs");
    expect(paths.logPath).toBe("D:\\runner-logs\\custom.log");
  });
});

describe("renderRunnerCmd", () => {
  test("generates batch script creating log dir and redirecting output to log file", () => {
    const cmd = renderRunnerCmd(sampleOpts);
    expect(cmd).toContain("@echo off");
    expect(cmd).toContain(
      'if not exist "C:\\Users\\User\\.cc-web-runner\\logs" mkdir "C:\\Users\\User\\.cc-web-runner\\logs"',
    );
    expect(cmd).toContain(
      '"C:\\Program Files\\cc-web-runner\\cc-web-runner-windows-x64.exe" connect --home "C:\\Users\\User\\.cc-web-runner" --log-dir "C:\\Users\\User\\.cc-web-runner\\logs" >> "C:\\Users\\User\\.cc-web-runner\\logs\\runner.log" 2>&1',
    );
  });

  test("the hatch rides into the task's command line", () => {
    // Same trap as the systemd unit: the scheduled `connect` re-runs the gate.
    const cmd = renderRunnerCmd({ ...sampleOpts, skipCliCheck: true });
    expect(cmd).toContain("connect --home ");
    expect(cmd).toContain("--skip-cli-check");
    expect(renderRunnerCmd(sampleOpts)).not.toContain("--skip-cli-check");
  });

  test("includes environment file when configured", () => {
    const cmd = renderRunnerCmd({
      ...sampleOpts,
      environmentFile: "C:\\runner.env",
    });
    expect(cmd).toContain('--env-file "C:\\runner.env"');
  });
});

describe("renderRunnerVbs", () => {
  test("generates windowless VBS launcher with WshShell.Run style 0", () => {
    const vbs = renderRunnerVbs("C:\\Users\\User\\.cc-web-runner\\run-runner.cmd");
    expect(vbs).toContain('Set WshShell = CreateObject("WScript.Shell")');
    expect(vbs).toContain(
      'WshShell.Run "cmd.exe /c """ & "C:\\Users\\User\\.cc-web-runner\\run-runner.cmd" & """", 0, True',
    );
  });
});

describe("renderWindowsTaskXml", () => {
  test("executes wscript with //nologo and the hidden vbs launcher", () => {
    expect(userTask).toContain("<Command>wscript.exe</Command>");
    expect(userTask).toContain(
      "<Arguments>//nologo &quot;C:\\Users\\User\\.cc-web-runner\\run-runner.vbs&quot;</Arguments>",
    );
    expect(userTask).toContain(
      "<WorkingDirectory>C:\\Users\\User\\.cc-web-runner</WorkingDirectory>",
    );
  });

  test("renders user-scoped logon trigger and interactive token principal", () => {
    expect(userTask).toContain("<LogonTrigger>");
    expect(userTask).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(userTask).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  });

  test("renders system-scoped boot trigger and SYSTEM principal", () => {
    const systemTask = renderWindowsTaskXml({
      executablePath: "C:\\cc-web-runner.exe",
      homeDir: "C:\\ProgramData\\cc-web-runner",
      scope: "system",
    });
    expect(systemTask).toContain("<BootTrigger>");
    expect(systemTask).toContain("<UserId>S-1-5-18</UserId>");
    expect(systemTask).toContain("<RunLevel>HighestAvailable</RunLevel>");
  });

  test("survives failures and runs indefinitely on AC and battery", () => {
    expect(userTask).toContain("<RestartOnFailure>");
    expect(userTask).toContain("<Interval>PT1M</Interval>");
    expect(userTask).toContain("<Count>3</Count>");
    expect(userTask).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(userTask).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
    expect(userTask).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(userTask).toContain("<Hidden>true</Hidden>");
  });

  test("carries no secret material", () => {
    expect(userTask).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(userTask).not.toContain("TOKEN=");
  });

  test("escapes XML special characters in vbs launcher path", () => {
    const withSpecialChars = renderWindowsTaskXml({
      executablePath: "C:\\Tools & Apps\\runner<test>.exe",
      homeDir: "C:\\Users\\A & B\\.cc-web-runner",
    });
    expect(withSpecialChars).toContain("C:\\Users\\A &amp; B\\.cc-web-runner\\run-runner.vbs");
    expect(withSpecialChars).toContain("C:\\Users\\A &amp; B\\.cc-web-runner");
  });
});

describe("installWindowsTask", () => {
  test("writes cmd, vbs, xml, stops prior instance, registers with schtasks /xml and runs", async () => {
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
      mkdir: async (path: string) => {
        calls.push({ kind: "mkdir", target: path });
      },
    };

    const paths = await installWindowsTask(
      {
        executablePath: "C:\\cc-web-runner.exe",
        homeDir: "C:\\Users\\User\\.cc-web-runner",
      },
      io,
    );

    expect(paths.xmlPath).toBe("C:\\Users\\User\\.cc-web-runner\\cc-web-runner-task.xml");
    expect(paths.cmdPath).toBe("C:\\Users\\User\\.cc-web-runner\\run-runner.cmd");
    expect(paths.vbsPath).toBe("C:\\Users\\User\\.cc-web-runner\\run-runner.vbs");
    expect(paths.logDir).toBe("C:\\Users\\User\\.cc-web-runner\\logs");
    expect(paths.logPath).toBe("C:\\Users\\User\\.cc-web-runner\\logs\\runner.log");

    expect(calls[0]).toEqual({
      kind: "mkdir",
      target: "C:\\Users\\User\\.cc-web-runner",
    });
    expect(calls[1]).toEqual({
      kind: "mkdir",
      target: "C:\\Users\\User\\.cc-web-runner\\logs",
    });
    expect(calls[2]).toEqual({
      kind: "write",
      target: "C:\\Users\\User\\.cc-web-runner\\run-runner.cmd",
    });
    expect(calls[3]).toEqual({
      kind: "write",
      target: "C:\\Users\\User\\.cc-web-runner\\run-runner.vbs",
    });
    expect(calls[4]).toEqual({
      kind: "write",
      target: "C:\\Users\\User\\.cc-web-runner\\cc-web-runner-task.xml",
    });
    expect(calls[5]).toEqual({
      kind: "run",
      target: "schtasks",
      args: ["/end", "/tn", TASK_NAME],
    });
    expect(calls[6]).toEqual({
      kind: "run",
      target: "schtasks",
      args: [
        "/create",
        "/tn",
        TASK_NAME,
        "/xml",
        "C:\\Users\\User\\.cc-web-runner\\cc-web-runner-task.xml",
        "/f",
      ],
    });
    expect(calls[7]).toEqual({
      kind: "run",
      target: "schtasks",
      args: ["/run", "/tn", TASK_NAME],
    });
    expect(TASK_NAME).toBe("cc-web-runner");
  });
});

describe("uninstallWindowsTask", () => {
  test("stops the task, deletes the task and removes xml, vbs, and cmd files", async () => {
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

    await uninstallWindowsTask(io, { homeDir: "C:\\Users\\User\\.cc-web-runner" });

    expect(calls[0]).toEqual({
      kind: "run",
      target: "schtasks",
      args: ["/end", "/tn", TASK_NAME],
    });
    expect(calls[1]).toEqual({
      kind: "run",
      target: "schtasks",
      args: ["/delete", "/tn", TASK_NAME, "/f"],
    });
    expect(calls[2]).toEqual({
      kind: "remove",
      target: "C:\\Users\\User\\.cc-web-runner\\cc-web-runner-task.xml",
    });
    expect(calls[3]).toEqual({
      kind: "remove",
      target: "C:\\Users\\User\\.cc-web-runner\\run-runner.vbs",
    });
    expect(calls[4]).toEqual({
      kind: "remove",
      target: "C:\\Users\\User\\.cc-web-runner\\run-runner.cmd",
    });
  });

  test("proceeds idempotently if schtasks /end fails (task not running)", async () => {
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
        if (args.includes("/end")) {
          throw new Error("Task is not running");
        }
      },
    };

    await uninstallWindowsTask(io, { homeDir: "C:\\Users\\User\\.cc-web-runner" });

    expect(calls).toHaveLength(5);
    const deleteCall = calls[1];
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.args).toEqual(["/delete", "/tn", TASK_NAME, "/f"]);
  });
});
