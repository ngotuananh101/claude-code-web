import { describe, expect, test } from "bun:test";
import { embeddedCliPath } from "@cc-web/agent-adapter";
import {
  type CapabilityCatalogLoad,
  type CapabilityCatalogQuery,
  discoverCapabilities,
} from "./capability-catalog.ts";

/**
 * The boot-time capabilities probe (§4.1).
 *
 * Three independent sources, each guarded on its own: the SDK probe answers
 * commands and agents, `installed_plugins.json` answers plugins, and the
 * settings files answer the MCP catalogue. The seams are injected, so these
 * tests never spawn a CLI nor touch a real home directory — what is asserted
 * is the mapping onto the wire shape, the per-source failure policy (a failed
 * source degrades to an empty list, never a rejection), the probe's cleanup
 * (its process is always closed), and the one security property: an MCP
 * server's `env` block never reaches the catalogue.
 */

const HOME = "/home/runner";
const CWD = "/srv/proj";

const sdkCommands = [
  {
    name: "compact",
    description: "Compact the conversation",
    argumentHint: "",
    builtin: true,
  },
  {
    name: "superpowers:brainstorming",
    description: "Brainstorm before building",
    aliases: ["brainstorm"],
  },
  {
    name: "wrong-typed-optionals",
    description: 42,
    argumentHint: null,
    builtin: "yes",
  },
];

const sdkAgents = [
  { name: "Explore", description: "Searches the codebase", model: "sonnet" },
  { name: "Plan" },
];

const installedPluginsJson = JSON.stringify({
  version: 2,
  plugins: {
    "superpowers@claude-plugins-official": [
      {
        scope: "user",
        installPath: "/home/runner/.claude/plugins/cache/claude-plugins-official/superpowers/7.0.0",
        version: "7.0.0",
        installedAt: "2026-09-17T04:01:54.725Z",
        lastUpdated: "2026-10-16T02:01:54.092Z",
        gitCommitSha: "bb92a77741419a4ab5f06e711a283343f1ada0c3",
      },
    ],
    "remember@claude-plugins-official": [
      {
        scope: "user",
        installPath: "/home/runner/.claude/plugins/cache/claude-plugins-official/remember/0.43.1",
        version: "0.43.1",
      },
      {
        scope: "project",
        installPath: "/srv/proj/.claude/plugins/cache/claude-plugins-official/remember/0.43.1",
        version: "0.43.1",
      },
    ],
  },
});

const projectInstalledPluginsJson = JSON.stringify({
  version: 2,
  plugins: {
    "local-dev-tools@claude-plugins-official": [
      {
        scope: "project",
        installPath: "/srv/proj/.claude/plugins/local-dev-tools",
        version: "0.1.0",
      },
    ],
  },
});

const userSettingsJson = JSON.stringify({
  env: { ANTHROPIC_AUTH_TOKEN: "sk-host-secret" },
  mcpServers: {
    "browseros-neo": {
      command: "node",
      args: ["/srv/servers/browseros-neo/index.js"],
      env: { BROWSEROS_API_KEY: "sk-live-browseros", PORT: "9222" },
    },
  },
});

const projectSettingsJson = JSON.stringify({
  mcpServers: {
    devtools: { command: "npx", args: ["-y", "@modelcontextprotocol/server-devtools"] },
  },
});

const localSettingsJson = JSON.stringify({
  mcpServers: {
    "local-gh": { url: "https://mcp.example.com/sse" },
  },
});

/** A fake filesystem: known paths answer content, everything else is ENOENT. */
function fakeFiles(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  const requested: string[] = [];
  const readFile = async (path: string): Promise<string> => {
    requested.push(path);
    const content = map.get(path);
    if (content === undefined) throw new Error(`ENOENT: no such file ${path}`);
    return content;
  };
  return { readFile, requested };
}

/**
 * A fake SDK seam. Records the probe's params; `init` answers the
 * initialization result, `fail`/`hang`/`throwInLoad` exercise the failure
 * policy, and `closed` counts the cleanup.
 */
function fakeLoad(
  overrides: {
    init?: { commands?: unknown; agents?: unknown };
    fail?: boolean;
    hang?: boolean;
    throwInLoad?: boolean;
  } = {},
) {
  const state = {
    params: [] as Array<{ prompt: unknown; options: Record<string, unknown> }>,
    closed: 0,
  };
  const load: CapabilityCatalogLoad = (params) => {
    state.params.push({ prompt: params.prompt, options: params.options });
    if (overrides.throwInLoad) throw new Error("spawn failed");
    const query: CapabilityCatalogQuery = {
      initializationResult: async () => {
        if (overrides.fail) throw new Error("initialize failed");
        if (overrides.hang) return new Promise(() => {});
        return overrides.init ?? {};
      },
      close: () => {
        state.closed += 1;
      },
    };
    return query;
  };
  return { load, state };
}

/** The well-formed host: every source answers. */
function hostFiles() {
  return fakeFiles({
    [`${HOME}/.claude/plugins/installed_plugins.json`]: installedPluginsJson,
    [`${CWD}/.claude/plugins/installed_plugins.json`]: projectInstalledPluginsJson,
    [`${HOME}/.claude/settings.json`]: userSettingsJson,
    [`${CWD}/.claude/settings.json`]: projectSettingsJson,
    [`${CWD}/.claude/settings.local.json`]: localSettingsJson,
  });
}

describe("discoverCapabilities", () => {
  test("maps the SDK init commands and agents onto the catalogue", async () => {
    const load = fakeLoad({ init: { commands: sdkCommands, agents: sdkAgents } });
    const files = fakeFiles({});

    const capabilities = await discoverCapabilities({
      cwd: CWD,
      homeDir: HOME,
      load: load.load,
      readFile: files.readFile,
    });

    expect(capabilities.commands).toEqual([
      { name: "compact", description: "Compact the conversation", builtin: true },
      {
        name: "superpowers:brainstorming",
        description: "Brainstorm before building",
        aliases: ["brainstorm"],
      },
      { name: "wrong-typed-optionals" },
    ]);
    expect(capabilities.agents).toEqual([
      { name: "Explore", description: "Searches the codebase", model: "sonnet" },
      { name: "Plan" },
    ]);
  });

  test("probes with the run's own setting sources and cwd", async () => {
    const load = fakeLoad({ init: {} });
    const files = fakeFiles({});

    await discoverCapabilities({
      cwd: CWD,
      homeDir: HOME,
      load: load.load,
      readFile: files.readFile,
    });

    const options = load.state.params[0]?.options;
    // §7.1: the catalogue must offer what a run would accept — the same sources.
    expect(options?.["settingSources"]).toEqual(["user", "project", "local"]);
    expect(options?.["cwd"]).toBe(CWD);
    // §20.3: the probe spawns the same embedded CLI a run does.
    expect(typeof options?.["pathToClaudeCodeExecutable"]).toBe("string");
    // A zero-turn probe: the prompt stream never yields.
    expect(load.state.params[0]?.prompt).toBeDefined();
  });

  test("passes an explicit CLI path to the SDK probe", async () => {
    const load = fakeLoad({ init: {} });
    await discoverCapabilities({
      cwd: CWD,
      homeDir: HOME,
      load: load.load,
      claudeCliPath: "/opt/claude/claude",
    });
    expect(load.state.params[0]?.options["pathToClaudeCodeExecutable"]).toBe("/opt/claude/claude");
  });

  test("omits the CLI path when the build embeds one", async () => {
    const load = fakeLoad({ init: {} });
    await discoverCapabilities({
      cwd: CWD,
      homeDir: HOME,
      load: load.load,
    });
    expect("pathToClaudeCodeExecutable" in (load.state.params[0]?.options ?? {})).toBe(
      embeddedCliPath() !== undefined,
    );
  });

  test("parses installed_plugins.json into plugin records", async () => {
    const load = fakeLoad({ init: {} });
    const files = hostFiles();

    const capabilities = await discoverCapabilities({
      cwd: CWD,
      homeDir: HOME,
      load: load.load,
      readFile: files.readFile,
    });

    expect(capabilities.plugins).toEqual([
      {
        name: "superpowers",
        source: "claude-plugins-official",
        version: "7.0.0",
        installPath: "/home/runner/.claude/plugins/cache/claude-plugins-official/superpowers/7.0.0",
        scope: "user",
      },
      {
        name: "remember",
        source: "claude-plugins-official",
        version: "0.43.1",
        installPath: "/home/runner/.claude/plugins/cache/claude-plugins-official/remember/0.43.1",
        scope: "user",
      },
      {
        name: "remember",
        source: "claude-plugins-official",
        version: "0.43.1",
        installPath: "/srv/proj/.claude/plugins/cache/claude-plugins-official/remember/0.43.1",
        scope: "project",
      },
      {
        name: "local-dev-tools",
        source: "claude-plugins-official",
        version: "0.1.0",
        installPath: "/srv/proj/.claude/plugins/local-dev-tools",
        scope: "project",
      },
    ]);
  });

  test("reads the user plugin manifest and the project one", async () => {
    const load = fakeLoad({ init: {} });
    const files = hostFiles();

    await discoverCapabilities({
      cwd: CWD,
      homeDir: HOME,
      load: load.load,
      readFile: files.readFile,
    });

    expect(files.requested).toContain(`${HOME}/.claude/plugins/installed_plugins.json`);
    expect(files.requested).toContain(`${CWD}/.claude/plugins/installed_plugins.json`);
  });

  test("maps settings mcpServers onto the catalogue, tagged by scope", async () => {
    const load = fakeLoad({ init: {} });
    const files = hostFiles();

    const capabilities = await discoverCapabilities({
      cwd: CWD,
      homeDir: HOME,
      load: load.load,
      readFile: files.readFile,
    });

    expect(capabilities.mcpServers).toEqual([
      {
        name: "browseros-neo",
        status: "configured",
        source: "user",
        command: "node /srv/servers/browseros-neo/index.js",
      },
      {
        name: "devtools",
        status: "configured",
        source: "project",
        command: "npx -y @modelcontextprotocol/server-devtools",
      },
      {
        name: "local-gh",
        status: "configured",
        source: "local",
        command: "https://mcp.example.com/sse",
      },
    ]);
  });

  test("never carries an MCP server's env block or its secrets", async () => {
    const load = fakeLoad({ init: {} });
    const files = hostFiles();

    const capabilities = await discoverCapabilities({
      cwd: CWD,
      homeDir: HOME,
      load: load.load,
      readFile: files.readFile,
    });

    // §4.1 secret sanitization: the env block is the one place a configured
    // server carries a credential, and it must not survive discovery.
    const serialized = JSON.stringify(capabilities);
    expect(serialized).not.toContain("sk-live-browseros");
    expect(serialized).not.toContain("BROWSEROS_API_KEY");
    expect(serialized).not.toContain("sk-host-secret");
    expect(serialized).not.toContain("ANTHROPIC_AUTH_TOKEN");
    for (const server of capabilities.mcpServers) {
      expect(Object.keys(server)).toEqual(
        expect.arrayContaining(["name", "status", "source", "command"]),
      );
      expect("env" in server).toBe(false);
    }
  });

  test("reads the user settings and both project settings files", async () => {
    const load = fakeLoad({ init: {} });
    const files = hostFiles();

    await discoverCapabilities({
      cwd: CWD,
      homeDir: HOME,
      load: load.load,
      readFile: files.readFile,
    });

    expect(files.requested).toContain(`${HOME}/.claude/settings.json`);
    expect(files.requested).toContain(`${CWD}/.claude/settings.json`);
    expect(files.requested).toContain(`${CWD}/.claude/settings.local.json`);
  });

  test("a failed SDK probe degrades to no commands and agents, files still read", async () => {
    const load = fakeLoad({ fail: true });
    const files = hostFiles();

    const capabilities = await discoverCapabilities({
      cwd: CWD,
      homeDir: HOME,
      load: load.load,
      readFile: files.readFile,
    });

    expect(capabilities.commands).toEqual([]);
    expect(capabilities.agents).toEqual([]);
    // The other two sources are independent of the probe.
    expect(capabilities.plugins.length).toBe(4);
    expect(capabilities.mcpServers.length).toBe(3);
    expect(load.state.closed).toBe(1);
  });

  test("a hanging probe is cut off by the timeout and still closed", async () => {
    const load = fakeLoad({ hang: true });
    const files = hostFiles();

    const capabilities = await discoverCapabilities({
      cwd: CWD,
      homeDir: HOME,
      load: load.load,
      readFile: files.readFile,
      timeoutMs: 5,
    });

    expect(capabilities.commands).toEqual([]);
    expect(capabilities.agents).toEqual([]);
    expect(load.state.closed).toBe(1);
  });

  test("a load that throws needs no close and still reads the files", async () => {
    const load = fakeLoad({ throwInLoad: true });
    const files = hostFiles();

    const capabilities = await discoverCapabilities({
      cwd: CWD,
      homeDir: HOME,
      load: load.load,
      readFile: files.readFile,
    });

    expect(capabilities.commands).toEqual([]);
    expect(capabilities.agents).toEqual([]);
    expect(load.state.closed).toBe(0);
    expect(capabilities.plugins.length).toBe(4);
    expect(capabilities.mcpServers.length).toBe(3);
  });

  test("missing files are empty lists, not errors", async () => {
    const load = fakeLoad({ init: {} });
    const files = fakeFiles({});

    const capabilities = await discoverCapabilities({
      cwd: CWD,
      homeDir: HOME,
      load: load.load,
      readFile: files.readFile,
    });

    expect(capabilities).toEqual({
      commands: [],
      plugins: [],
      mcpServers: [],
      agents: [],
    });
  });

  test("malformed files are skipped, not fatal", async () => {
    const load = fakeLoad({ init: {} });
    const files = fakeFiles({
      [`${HOME}/.claude/plugins/installed_plugins.json`]: "not json",
      [`${HOME}/.claude/settings.json`]: "{",
      [`${CWD}/.claude/settings.json`]: "[]",
      [`${CWD}/.claude/settings.local.json`]: "null",
    });

    const capabilities = await discoverCapabilities({
      cwd: CWD,
      homeDir: HOME,
      load: load.load,
      readFile: files.readFile,
    });

    expect(capabilities.plugins).toEqual([]);
    expect(capabilities.mcpServers).toEqual([]);
  });

  test("a malformed SDK answer degrades to empty lists", async () => {
    for (const init of [
      { commands: "pro", agents: [1] },
      { commands: [{ name: "" }], agents: [{ name: "" }] },
    ]) {
      const load = fakeLoad({ init });
      const files = fakeFiles({});

      const capabilities = await discoverCapabilities({
        cwd: CWD,
        homeDir: HOME,
        load: load.load,
        readFile: files.readFile,
      });

      expect(capabilities.commands).toEqual([]);
      expect(capabilities.agents).toEqual([]);
    }
  });
});
