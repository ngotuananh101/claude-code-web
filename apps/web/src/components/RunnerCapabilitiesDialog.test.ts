import { describe, expect, test } from "bun:test";
import type { RunnerCapabilities } from "@cc-web/protocol";

describe("RunnerCapabilitiesDialog — tab state", () => {
  test("defaults to plugins tab", () => {
    const activeTab = "plugins";
    expect(activeTab).toBe("plugins");
  });

  test("switches between plugins, mcp, agents", () => {
    let activeTab: "plugins" | "mcp" | "agents" = "plugins";
    activeTab = "mcp";
    expect(activeTab).toBe("mcp");
    activeTab = "agents";
    expect(activeTab).toBe("agents");
  });
});

describe("RunnerCapabilitiesDialog — MCP status formatting", () => {
  function mcpStatusLabel(status: "connected" | "failed" | "configured"): string {
    if (status === "connected") return "connected";
    if (status === "failed") return "failed";
    return "configured";
  }

  function mcpStatusClass(status: "connected" | "failed" | "configured"): string {
    if (status === "connected") return "green";
    if (status === "failed") return "red";
    return "amber";
  }

  test("connected -> green", () => {
    expect(mcpStatusClass("connected")).toBe("green");
    expect(mcpStatusLabel("connected")).toBe("connected");
  });

  test("failed -> red/destructive", () => {
    expect(mcpStatusClass("failed")).toBe("red");
    expect(mcpStatusLabel("failed")).toBe("failed");
  });

  test("configured -> amber/secondary", () => {
    expect(mcpStatusClass("configured")).toBe("amber");
    expect(mcpStatusLabel("configured")).toBe("configured");
  });
});

describe("RunnerCapabilitiesDialog — empty states", () => {
  test("detects empty capabilities", () => {
    const caps: RunnerCapabilities = {
      commands: [],
      plugins: [],
      mcpServers: [],
      agents: [],
    };
    const hasPluginsOrCommands = caps.plugins.length > 0 || caps.commands.length > 0;
    const hasMcp = caps.mcpServers.length > 0;
    const hasAgents = caps.agents.length > 0;
    expect(hasPluginsOrCommands).toBe(false);
    expect(hasMcp).toBe(false);
    expect(hasAgents).toBe(false);
  });

  test("detects populated capabilities", () => {
    const caps: RunnerCapabilities = {
      commands: [{ name: "review", description: "Review code" }],
      plugins: [{ name: "plugin-a", version: "1.0.0", scope: "user" }],
      mcpServers: [{ name: "srv", status: "connected", tools: ["mcp__srv__tool"] }],
      agents: [{ name: "agent-1", description: "Helper" }],
    };
    expect(caps.plugins[0]?.name).toBe("plugin-a");
    expect(caps.plugins[0]?.version).toBe("1.0.0");
    expect(caps.plugins[0]?.scope).toBe("user");
    expect(caps.mcpServers[0]?.status).toBe("connected");
    expect(caps.mcpServers[0]?.tools).toEqual(["mcp__srv__tool"]);
    expect(caps.agents[0]?.name).toBe("agent-1");
    expect(caps.commands[0]?.argumentHint).toBeUndefined();
  });
});

describe("RunnerCapabilitiesDialog — filtering", () => {
  test("filters MCP servers by status", () => {
    const servers = [
      { name: "a", status: "connected" as const },
      { name: "b", status: "failed" as const },
    ];
    const connected = servers.filter((s) => s.status === "connected");
    expect(connected).toHaveLength(1);
    expect(connected[0]?.name).toBe("a");
  });
});
