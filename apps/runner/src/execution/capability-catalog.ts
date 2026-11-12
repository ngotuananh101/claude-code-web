/**
 * The capabilities this runner's Claude Code offers (§4.1), discovered once at
 * boot and advertised in the hello under `runnerCapabilities`.
 *
 * Three independent sources, each guarded on its own:
 *
 * - the SDK answers commands and agents — a zero-turn probe run with the same
 *   `settingSources` a run reads, so the catalogue offers exactly what a run
 *   would accept;
 * - `installed_plugins.json` (user and project) answers plugins;
 * - the settings files (user, project, local) answer the MCP catalogue.
 *
 * Discovery is best-effort per source: a failed probe, a missing manifest or a
 * malformed settings file degrades that source to an empty list, never a
 * rejection — a runner with a broken plugin directory still boots.
 *
 * An MCP server's `env` block is the one place a configured server carries a
 * credential, and it is never read into a record (§4.1 secret sanitization).
 * The protocol parsers whitelist the fields that survive regardless, so the
 * redaction holds even if a source shape changes underneath.
 */

import { readFile as readFileFs } from "node:fs/promises";
import { embeddedCliPath } from "@cc-web/agent-adapter";
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
} from "@cc-web/protocol";

/** The subset of the SDK's `Query` this module uses. */
export type CapabilityCatalogQuery = {
  initializationResult(): Promise<{ commands?: unknown; agents?: unknown }>;
  close?: () => void;
};

/** The SDK seam: a `query()` whose query can be closed after its init is read. */
export type CapabilityCatalogLoad = (params: {
  prompt: AsyncIterable<never>;
  options: Record<string, unknown>;
}) => CapabilityCatalogQuery;

/** Reads a file's full contents; injected so tests never touch a disk. */
export type CapabilityCatalogReadFile = (path: string) => Promise<string>;

export type DiscoverCapabilitiesOptions = {
  /**
   * The directory the probe runs in. Its project settings and plugin manifest
   * are read exactly as a run's would be, so the catalogue offers what a run
   * in this directory would accept.
   */
  cwd: string;
  /** The host user's home; anchors the `~/.claude` reads. */
  homeDir: string;
  /** Overrides the SDK seam for tests; production loads the real one lazily. */
  load?: CapabilityCatalogLoad;
  /** Overrides the file seam for tests. */
  readFile?: CapabilityCatalogReadFile;
  /** Hard cap on the SDK probe; past it, commands and agents are empty. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;

/** A wrapper around fs/promises.readFile that returns string. */
function readFile(path: string): Promise<string> {
  return readFileFs(path, "utf8");
}

/**
 * The full capabilities catalogue. Every source degrades to an empty list on
 * failure — never a rejection: a host where discovery cannot answer still
 * runs, it just advertises nothing.
 */
export async function discoverCapabilities(
  options: DiscoverCapabilitiesOptions,
): Promise<RunnerCapabilities> {
  const read = options.readFile ?? readFile;

  // §7.1: the catalogue must offer what a run would accept, so the probe reads
  // the same setting sources a run does. A zero-turn query: the prompt stream
  // never yields, and `close()` in the finally ends the spawned CLI.
  let commands: RunnerCommand[] = [];
  let agents: RunnerAgent[] = [];
  let query: CapabilityCatalogQuery | undefined;
  try {
    const load = options.load ?? loadSdk();
    query = load({
      prompt: noTurns(),
      options: {
        cwd: options.cwd,
        settingSources: ["user", "project", "local"],
        // §20.3: a compiled binary cannot let the SDK resolve the CLI itself.
        ...(embeddedCliPath() === undefined
          ? {}
          : { pathToClaudeCodeExecutable: embeddedCliPath() }),
      },
    });
    const init = await withTimeout(
      query.initializationResult(),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    // Extra SDK fields are dropped by the protocol parsers — only what the
    // wire carries survives.
    commands = parseRunnerCommands(init.commands) ?? [];
    agents = parseRunnerAgents(init.agents) ?? [];
  } catch {
    // A failed probe costs the command and agent lists only; the file sources
    // below are independent of it.
    commands = [];
    agents = [];
  } finally {
    // Closing is what stops the spawned CLI; a timed-out probe must not leave
    // a process behind. A load that threw never produced a query to close.
    query?.close?.();
  }

  const plugins = [
    ...pluginsFromManifest(
      await readJson(`${options.homeDir}/.claude/plugins/installed_plugins.json`, read),
    ),
    ...pluginsFromManifest(
      await readJson(`${options.cwd}/.claude/plugins/installed_plugins.json`, read),
    ),
  ];

  const mcpServers = [
    ...mcpServersFromSettings(
      await readJson(`${options.homeDir}/.claude/settings.json`, read),
      "user",
    ),
    ...mcpServersFromSettings(
      await readJson(`${options.cwd}/.claude/settings.json`, read),
      "project",
    ),
    ...mcpServersFromSettings(
      await readJson(`${options.cwd}/.claude/settings.local.json`, read),
      "local",
    ),
  ];

  return {
    commands,
    plugins: parseRunnerPlugins(plugins) ?? [],
    mcpServers: parseRunnerMcpServers(mcpServers) ?? [],
    agents,
  };
}

async function* noTurns(): AsyncGenerator<never> {
  // Intentionally never yields.
}

async function readJson(path: string, read: CapabilityCatalogReadFile): Promise<unknown> {
  try {
    return JSON.parse(await read(path));
  } catch {
    // Absent, unreadable or malformed — the source simply has nothing to say.
    return undefined;
  }
}

/**
 * `installed_plugins.json` keys its map by `name@marketplace` and lists one
 * entry per installation scope. Each installation becomes one catalogue
 * record; manifest junk (`installedAt`, `gitCommitSha`, …) never survives the
 * parser.
 */
function pluginsFromManifest(manifest: unknown): RunnerPlugin[] {
  const plugins = manifestMap(manifest, "plugins");
  if (plugins === undefined) return [];
  const records: RunnerPlugin[] = [];
  for (const [key, installs] of Object.entries(plugins)) {
    if (!Array.isArray(installs)) continue;
    const separator = key.indexOf("@");
    const name = separator === -1 ? key : key.slice(0, separator);
    const source = separator === -1 ? undefined : key.slice(separator + 1);
    for (const install of installs) {
      if (typeof install !== "object" || install === null) continue;
      const entry = install as Record<string, unknown>;
      records.push({
        name,
        ...(source !== undefined ? { source } : {}),
        ...stringField(entry, "version"),
        ...stringField(entry, "installPath"),
        ...stringField(entry, "scope"),
      });
    }
  }
  return records;
}

/**
 * A settings file's `mcpServers` map, one record per server, tagged with the
 * scope it was configured in. Only `command` (with its `args`) or `url` is
 * carried — the `env` block is never read into a record.
 */
function mcpServersFromSettings(settings: unknown, source: McpSource): RunnerMcpServer[] {
  const servers = manifestMap(settings, "mcpServers");
  if (servers === undefined) return [];
  const records: RunnerMcpServer[] = [];
  for (const [name, config] of Object.entries(servers)) {
    if (typeof config !== "object" || config === null) continue;
    const command = mcpCommand(config as Record<string, unknown>);
    records.push({
      name,
      status: "configured",
      source,
      ...(command !== undefined ? { command } : {}),
    });
  }
  return records;
}

type McpSource = NonNullable<RunnerMcpServer["source"]>;

/** How a configured server is launched: a command line, or a remote URL. */
function mcpCommand(config: Record<string, unknown>): string | undefined {
  const command = config["command"];
  if (typeof command === "string" && command.trim() !== "") {
    const args = config["args"];
    const words = Array.isArray(args)
      ? args.filter((arg): arg is string => typeof arg === "string")
      : [];
    return [command, ...words].join(" ");
  }
  const url = config["url"];
  if (typeof url === "string" && url.trim() !== "") return url;
  return undefined;
}

/** The object-valued `field` of a JSON document, or `undefined` for anything else. */
function manifestMap(document: unknown, field: string): Record<string, unknown> | undefined {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return undefined;
  }
  const value = (document as Record<string, unknown>)[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** A string-valued field as a single-key spread; anything else is absent. */
function stringField(record: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = record[field];
  return typeof value === "string" ? { [field]: value } : {};
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`capability discovery timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The real SDK, resolved synchronously and only when a probe actually runs. */
function loadSdk(): CapabilityCatalogLoad {
  const sdk = require("@anthropic-ai/claude-agent-sdk") as { query: CapabilityCatalogLoad };
  return sdk.query;
}
