/**
 * The runner capabilities catalogue (design spec §4.1): the commands, plugins,
 * MCP servers and agents a runner's Claude Code discovered at boot, advertised
 * in the hello under `runnerCapabilities`.
 *
 * Everything here is display-only discovery data, and that shapes the parsing
 * contract. A record the server cannot fully understand is skipped, never
 * fatal: one malformed entry must not cost the runner its connection nor blank
 * the rest of the catalogue, exactly like an unknown effort level on a model.
 * Only the top-level shape is strict — a field that is present but not an
 * array is `undefined` (malformed), because that is a protocol violation
 * rather than a bad entry.
 *
 * Records are built field-by-field from a whitelist. A field that is never
 * copied cannot be journaled — which is why an MCP server's `env` block, the
 * one place a catalogue record can carry a credential, never survives parsing
 * (§4.1 secret sanitization), no matter what the runner sent.
 */

const MCP_STATUSES = ["connected", "failed", "configured"] as const;
type McpStatus = (typeof MCP_STATUSES)[number];

const MCP_SOURCES = ["user", "project", "local"] as const;
type McpSource = (typeof MCP_SOURCES)[number];

export type RunnerCommand = {
  name: string;
  description?: string;
  argumentHint?: string;
  builtin?: boolean;
  aliases?: string[];
};

export type RunnerPlugin = {
  name: string;
  version?: string;
  source?: string;
  installPath?: string;
  scope?: string;
};

export type RunnerMcpServer = {
  name: string;
  status: McpStatus;
  source?: McpSource;
  command?: string;
  tools?: string[];
};

export type RunnerAgent = {
  name: string;
  description?: string;
  model?: string;
};

export type RunnerCapabilities = {
  commands: RunnerCommand[];
  plugins: RunnerPlugin[];
  mcpServers: RunnerMcpServer[];
  agents: RunnerAgent[];
};

/**
 * Parse the `commands` catalogue: the slash commands this runner's Claude Code
 * offers, builtin and plugin-provided alike. Absent means a runner that
 * predates discovery — an empty catalogue, never an error.
 */
export function parseRunnerCommands(input: unknown): RunnerCommand[] | undefined {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return undefined;
  const commands: RunnerCommand[] = [];
  for (const entry of input) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = record["name"];
    if (typeof name !== "string" || name.trim() === "") continue;

    const description = record["description"];
    const argumentHint = record["argumentHint"];
    const aliases = record["aliases"];
    commands.push({
      name: name.trim(),
      ...(typeof description === "string" && description.trim() !== ""
        ? { description: description.trim() }
        : {}),
      ...(typeof argumentHint === "string" && argumentHint.trim() !== ""
        ? { argumentHint: argumentHint.trim() }
        : {}),
      ...(typeof record["builtin"] === "boolean" ? { builtin: record["builtin"] } : {}),
      ...(Array.isArray(aliases) && stringEntries(aliases).length > 0
        ? { aliases: stringEntries(aliases) }
        : {}),
    });
  }
  return commands;
}

/**
 * Parse the `plugins` catalogue: the plugins installed on this runner. A
 * plugin manifest is not a secret surface, but unknown fields never ride
 * along — only the wire fields survive.
 */
export function parseRunnerPlugins(input: unknown): RunnerPlugin[] | undefined {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return undefined;
  const plugins: RunnerPlugin[] = [];
  for (const entry of input) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = record["name"];
    if (typeof name !== "string" || name.trim() === "") continue;

    const version = record["version"];
    const source = record["source"];
    const installPath = record["installPath"];
    const scope = record["scope"];
    plugins.push({
      name: name.trim(),
      ...(typeof version === "string" && version.trim() !== "" ? { version: version.trim() } : {}),
      ...(typeof source === "string" && source.trim() !== "" ? { source: source.trim() } : {}),
      ...(typeof installPath === "string" && installPath.trim() !== ""
        ? { installPath: installPath.trim() }
        : {}),
      ...(typeof scope === "string" && scope.trim() !== "" ? { scope: scope.trim() } : {}),
    });
  }
  return plugins;
}

/**
 * Parse the `mcpServers` catalogue: the MCP servers this runner's Claude Code
 * has configured. `status` is the one field the UI renders as a badge, so an
 * unknown status drops the whole record rather than journal a status it never
 * had; `source` is descriptive, so an unknown scope costs only that field.
 * The `env` block — the one place a catalogue record can carry a credential —
 * is never copied, by construction.
 */
export function parseRunnerMcpServers(input: unknown): RunnerMcpServer[] | undefined {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return undefined;
  const servers: RunnerMcpServer[] = [];
  for (const entry of input) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = record["name"];
    if (typeof name !== "string" || name.trim() === "") continue;

    const status = MCP_STATUSES.find((candidate) => candidate === record["status"]);
    if (status === undefined) continue;

    const source = MCP_SOURCES.find((candidate) => candidate === record["source"]);
    const command = record["command"];
    const tools = record["tools"];
    servers.push({
      name: name.trim(),
      status,
      ...(source !== undefined ? { source } : {}),
      ...(typeof command === "string" && command.trim() !== "" ? { command: command.trim() } : {}),
      ...(Array.isArray(tools) && stringEntries(tools).length > 0
        ? { tools: stringEntries(tools) }
        : {}),
    });
  }
  return servers;
}

/**
 * Parse the `agents` catalogue: the subagents this runner's Claude Code
 * defines. Absent means a runner that predates discovery — an empty catalogue.
 */
export function parseRunnerAgents(input: unknown): RunnerAgent[] | undefined {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return undefined;
  const agents: RunnerAgent[] = [];
  for (const entry of input) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = record["name"];
    if (typeof name !== "string" || name.trim() === "") continue;

    const description = record["description"];
    const model = record["model"];
    agents.push({
      name: name.trim(),
      ...(typeof description === "string" && description.trim() !== ""
        ? { description: description.trim() }
        : {}),
      ...(typeof model === "string" && model.trim() !== "" ? { model: model.trim() } : {}),
    });
  }
  return agents;
}

/** The string entries of a list, in order — used for `aliases` and `tools`. */
function stringEntries(value: unknown[]): string[] {
  return value.filter((entry): entry is string => typeof entry === "string");
}
