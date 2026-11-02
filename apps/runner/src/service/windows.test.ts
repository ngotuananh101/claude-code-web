import { describe, expect, test } from "bun:test";
import {
  installWindowsTask,
  renderWindowsTaskXml,
  TASK_NAME,
  uninstallWindowsTask,
} from "./windows.ts";

const userTask = renderWindowsTaskXml({
  executablePath: "C:\\Program Files\\cc-web-runner\\cc-web-runner-windows-x64.exe",
  homeDir: "C:\\Users\\User\\.cc-web-runner",
});

describe("renderWindowsTaskXml", () => {
  test("starts the connector subcommand with runner home", () => {
    expect(userTask).toContain(
      "<Command>C:\\Program Files\\cc-web-runner\\cc-web-runner-windows-x64.exe</Command>",
    );
    expect(userTask).toContain(
      "<Arguments>connect --home &quot;C:\\Users\\User\\.cc-web-runner&quot;</Arguments>",
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

  test("escapes XML special characters in paths and args", () => {
    const withSpecialChars = renderWindowsTaskXml({
      executablePath: "C:\\Tools & Apps\\runner<test>.exe",
      homeDir: "C:\\Users\\A & B\\.cc-web-runner",
    });
    expect(withSpecialChars).toContain("C:\\Tools &amp; Apps\\runner&lt;test&gt;.exe");
    expect(withSpecialChars).toContain("C:\\Users\\A &amp; B\\.cc-web-runner");
  });

  test("passes environment file via command argument when specified", () => {
    const withEnv = renderWindowsTaskXml({
      executablePath: "C:\\cc-web-runner.exe",
      homeDir: "C:\\Users\\User\\.cc-web-runner",
      environmentFile: "C:\\cc-web-runner.env",
    });
    expect(withEnv).toContain("--env-file &quot;C:\\cc-web-runner.env&quot;");
  });
});

describe("installWindowsTask", () => {
  test("writes the xml definition, registers task with schtasks /xml and runs it", async () => {
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

    const xmlPath = await installWindowsTask(
      {
        executablePath: "C:\\cc-web-runner.exe",
        homeDir: "C:\\Users\\User\\.cc-web-runner",
      },
      io,
    );

    expect(xmlPath).toBe("C:\\Users\\User\\.cc-web-runner/cc-web-runner-task.xml");
    expect(calls[0]).toEqual({
      kind: "write",
      target: "C:\\Users\\User\\.cc-web-runner/cc-web-runner-task.xml",
    });
    expect(calls[1]).toEqual({
      kind: "run",
      target: "schtasks",
      args: [
        "/create",
        "/tn",
        TASK_NAME,
        "/xml",
        "C:\\Users\\User\\.cc-web-runner/cc-web-runner-task.xml",
        "/f",
      ],
    });
    expect(calls[2]).toEqual({
      kind: "run",
      target: "schtasks",
      args: ["/run", "/tn", TASK_NAME],
    });
    expect(TASK_NAME).toBe("cc-web-runner");
  });
});

describe("uninstallWindowsTask", () => {
  test("stops the task, deletes the task and removes the xml file", async () => {
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
      target: "C:\\Users\\User\\.cc-web-runner/cc-web-runner-task.xml",
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

    expect(calls).toHaveLength(3);
    const deleteCall = calls[1];
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.args).toEqual(["/delete", "/tn", TASK_NAME, "/f"]);
  });
});
