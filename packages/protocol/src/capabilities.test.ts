import { describe, expect, test } from "bun:test";
import {
  parseRunnerAgents,
  parseRunnerCommands,
  parseRunnerMcpServers,
  parseRunnerPlugins,
  type RunnerAgent,
  type RunnerCapabilities,
  type RunnerCommand,
  type RunnerMcpServer,
  type RunnerPlugin,
} from "./capabilities.ts";

describe("parseRunnerCommands", () => {
  test("an absent field is an empty list, not an error", () => {
    // A runner that predates discovery advertises nothing; the composer then
    // falls back to its default catalogue rather than treating the hello as
    // malformed.
    expect(parseRunnerCommands(undefined)).toEqual([]);
  });

  test("keeps the wire fields and drops the rest", () => {
    const parsed = parseRunnerCommands([
      {
        name: "code-review",
        description: "Review the current diff",
        argumentHint: "[effort]",
        builtin: true,
        aliases: ["review", "cr"],
        // SDK/runner internals ride along; only the wire fields survive.
        plugin: "superpowers",
        env: { SOME_TOKEN: "x" },
      },
    ]);
    expect(parsed).toEqual([
      {
        name: "code-review",
        description: "Review the current diff",
        argumentHint: "[effort]",
        builtin: true,
        aliases: ["review", "cr"],
      },
    ]);
  });

  test("a record with only the required name parses", () => {
    expect(parseRunnerCommands([{ name: "compact" }])).toEqual([{ name: "compact" }]);
  });

  test("a malformed record is ignored, not fatal", () => {
    // The catalogue is display-only discovery data: one bad entry must not
    // cost the whole list, and must not refuse the hello.
    const parsed = parseRunnerCommands([
      { name: "compact" },
      "not-a-command",
      null,
      {},
      { name: "" },
      { name: 42 },
      { name: "verify", builtin: "yes" },
      { name: "loop", aliases: "review" },
      { name: "debug", aliases: ["db", 7, null] },
    ]);
    expect(parsed).toEqual([
      { name: "compact" },
      { name: "verify" },
      { name: "loop" },
      { name: "debug", aliases: ["db"] },
    ]);
  });

  test("a name is trimmed and a blank-after-trim name is dropped", () => {
    expect(parseRunnerCommands([{ name: "  spaced  " }])).toEqual([{ name: "spaced" }]);
    expect(parseRunnerCommands([{ name: "   " }])).toEqual([]);
  });

  test("a malformed list is undefined", () => {
    for (const bad of ["compact", { name: "compact" }, 42, null]) {
      expect(parseRunnerCommands(bad)).toBeUndefined();
    }
  });

  test("an empty list is an empty list", () => {
    expect(parseRunnerCommands([])).toEqual([]);
  });

  test("the parsed shape satisfies the wire type", () => {
    const parsed = parseRunnerCommands([
      { name: "x", description: "d", argumentHint: "a", builtin: false, aliases: [] },
    ]);
    const typed: RunnerCommand[] = parsed ?? [];
    expect(typed[0]?.name).toBe("x");
  });
});

describe("parseRunnerPlugins", () => {
  test("an absent field is an empty list, not an error", () => {
    expect(parseRunnerPlugins(undefined)).toEqual([]);
  });

  test("keeps the wire fields and drops the rest", () => {
    const parsed = parseRunnerPlugins([
      {
        name: "superpowers",
        version: "1.2.3",
        source: "claude-plugins-official",
        installPath: "/home/runner/.claude/plugins/superpowers",
        scope: "user",
        // A plugin manifest is not a secret surface, but unknown fields never
        // ride along: only the wire fields survive.
        env: { API_KEY: "secret" },
        settings: { theme: "dark" },
      },
    ]);
    expect(parsed).toEqual([
      {
        name: "superpowers",
        version: "1.2.3",
        source: "claude-plugins-official",
        installPath: "/home/runner/.claude/plugins/superpowers",
        scope: "user",
      },
    ]);
  });

  test("a record with only the required name parses", () => {
    expect(parseRunnerPlugins([{ name: "remember" }])).toEqual([{ name: "remember" }]);
  });

  test("a malformed record is ignored, not fatal", () => {
    const parsed = parseRunnerPlugins([
      { name: "remember" },
      7,
      { name: "" },
      { name: "superpowers", version: 1.2 },
      { name: "dataviz", scope: { level: "user" } },
    ]);
    expect(parsed).toEqual([{ name: "remember" }, { name: "superpowers" }, { name: "dataviz" }]);
  });

  test("a malformed list is undefined", () => {
    for (const bad of ["remember", null]) {
      expect(parseRunnerPlugins(bad)).toBeUndefined();
    }
  });

  test("the parsed shape satisfies the wire type", () => {
    const parsed = parseRunnerPlugins([
      { name: "p", version: "0.1.0", source: "npm", installPath: "/p", scope: "project" },
    ]);
    const typed: RunnerPlugin[] = parsed ?? [];
    expect(typed[0]?.scope).toBe("project");
  });
});

describe("parseRunnerMcpServers", () => {
  test("an absent field is an empty list, not an error", () => {
    expect(parseRunnerMcpServers(undefined)).toEqual([]);
  });

  test("keeps the wire fields and drops the rest", () => {
    const parsed = parseRunnerMcpServers([
      {
        name: "browseros-neo",
        status: "connected",
        source: "user",
        command: "node /opt/browseros-neo/dist/index.js",
        tools: ["open", "click"],
        // Anything the settings file carried besides the catalogue fields is
        // dropped by construction.
        timeout: 30,
      },
    ]);
    expect(parsed).toEqual([
      {
        name: "browseros-neo",
        status: "connected",
        source: "user",
        command: "node /opt/browseros-neo/dist/index.js",
        tools: ["open", "click"],
      },
    ]);
  });

  test("strips the env block so credentials never reach the journal", () => {
    // §4.1 secret sanitization: an MCP server definition carries env vars, and
    // a runner that failed to redact them must not get them persisted server-
    // side. The parser builds records field-by-field, so `env` cannot survive.
    const parsed = parseRunnerMcpServers([
      {
        name: "db",
        status: "configured",
        env: {
          DATABASE_URL: "postgres://user:password@host/db",
          API_KEY: "sk-live",
          ANTHROPIC_AUTH_TOKEN: "token",
        },
      },
    ]);
    expect(parsed).toEqual([{ name: "db", status: "configured" }]);
    expect(JSON.stringify(parsed)).not.toContain("password");
    expect(JSON.stringify(parsed)).not.toContain("sk-live");
  });

  test("an unknown status drops the record, an unknown source drops only the field", () => {
    // Status is the one field the UI renders as a badge; a status this server
    // cannot name must not be journaled as one. Source is descriptive, so a
    // newer runner naming an unknown scope costs only that field.
    const parsed = parseRunnerMcpServers([
      { name: "a", status: "connected", source: "user" },
      { name: "b", status: "crashed" },
      { name: "c", status: "failed", source: "team" },
    ]);
    expect(parsed).toEqual([
      { name: "a", status: "connected", source: "user" },
      { name: "c", status: "failed" },
    ]);
  });

  test("a malformed record is ignored, not fatal", () => {
    const parsed = parseRunnerMcpServers([
      { name: "a", status: "configured" },
      "not-a-server",
      null,
      {},
      { status: "connected" },
      { name: "b" },
      { name: "c", status: 42 },
      { name: "d", status: "connected", tools: "open" },
      { name: "e", status: "connected", tools: ["t1", 9] },
    ]);
    expect(parsed).toEqual([
      { name: "a", status: "configured" },
      { name: "d", status: "connected" },
      { name: "e", status: "connected", tools: ["t1"] },
    ]);
  });

  test("a malformed list is undefined", () => {
    for (const bad of ["db", { name: "db", status: "connected" }, null]) {
      expect(parseRunnerMcpServers(bad)).toBeUndefined();
    }
  });

  test("the parsed shape satisfies the wire type", () => {
    const parsed = parseRunnerMcpServers([
      { name: "m", status: "failed", source: "project", command: "cmd", tools: [] },
    ]);
    const typed: RunnerMcpServer[] = parsed ?? [];
    expect(typed[0]?.status).toBe("failed");
  });
});

describe("parseRunnerAgents", () => {
  test("an absent field is an empty list, not an error", () => {
    expect(parseRunnerAgents(undefined)).toEqual([]);
  });

  test("keeps the wire fields and drops the rest", () => {
    const parsed = parseRunnerAgents([
      {
        name: "Explore",
        description: "Read-only search agent",
        model: "sonnet",
        tools: ["Read", "Grep"],
      },
    ]);
    expect(parsed).toEqual([
      { name: "Explore", description: "Read-only search agent", model: "sonnet" },
    ]);
  });

  test("a malformed record is ignored, not fatal", () => {
    const parsed = parseRunnerAgents([
      { name: "Explore" },
      7,
      { name: "" },
      { description: "no name" },
      { name: "Plan", model: 42 },
    ]);
    expect(parsed).toEqual([{ name: "Explore" }, { name: "Plan" }]);
  });

  test("a malformed list is undefined", () => {
    for (const bad of ["Explore", null]) {
      expect(parseRunnerAgents(bad)).toBeUndefined();
    }
  });

  test("the parsed shape satisfies the wire type", () => {
    const parsed = parseRunnerAgents([{ name: "a", description: "d", model: "opus" }]);
    const typed: RunnerAgent[] = parsed ?? [];
    expect(typed[0]?.model).toBe("opus");
  });
});

describe("RunnerCapabilities", () => {
  test("the composed catalogue shape satisfies the wire type", () => {
    const capabilities: RunnerCapabilities = {
      commands: [{ name: "compact", builtin: true }],
      plugins: [{ name: "superpowers", version: "1.0.0" }],
      mcpServers: [{ name: "db", status: "configured" }],
      agents: [{ name: "Explore" }],
    };
    expect(capabilities.commands[0]?.builtin).toBe(true);
  });
});
