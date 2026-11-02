/**
 * Runner hello negotiation (§6.2, §17.4).
 *
 * The hello is the first thing a Runner sends after authentication. Three things
 * happen here, in this order, because each one can invalidate the next:
 *
 *  1. shape — reject anything that is not a well-formed hello
 *  2. secrets — reject payloads carrying provider credentials or raw env
 *  3. version — reject a protocol the server cannot speak
 *
 * A negotiated connection is `connected`, never `ready`: §6.2 requires
 * reconciliation before dispatch.
 */

import {
  parseRunnerAgents,
  parseRunnerCommands,
  parseRunnerMcpServers,
  parseRunnerPlugins,
  type RunnerCapabilities,
} from "./capabilities.ts";
import { parseRunnerModels, type RunnerModel } from "./models.ts";
import { type DeclaredWorkspace, parseDeclaredWorkspaces } from "./reconcile.ts";

export type ServerPolicy = {
  minProtocolVersion: number;
  maxProtocolVersion: number;
  /** Upper bound on runs this server is willing to have in flight per runner. */
  maxConcurrentRuns: number;
};

export type NegotiatedPolicy = {
  maxConcurrentRuns: number;
};

export type Negotiation = {
  protocolVersion: number;
  policy: NegotiatedPolicy;
};

export type NegotiateResult =
  | {
      ok: true;
      negotiation: Negotiation;
      /** Always "connected" — reconciliation promotes it to ready. */
      connectionState: "connected";
      /** Workspaces the runner declares it serves (§15.1); empty for older runners. */
      workspaces: DeclaredWorkspace[];
      /**
       * Features the runner can serve. Empty for a runner that predates the
       * field, which is the signal not to dispatch work it cannot answer — a
       * command kind it does not implement would otherwise be delivered and
       * misread.
       */
      capabilities: string[];
      /**
       * The models this runner's Claude Code offers, discovered at boot. Empty
       * for a runner that predates the field — the dispatch route then falls
       * back to the protocol's own `MODEL_IDS`, never to "accept anything".
       */
      models: RunnerModel[];
      /**
       * The commands, plugins, MCP servers and agents this runner discovered
       * at boot (§4.1). Empty lists for a runner that predates discovery —
       * the capabilities dialog then shows nothing, never refuses a hello.
       */
      runnerCapabilities: RunnerCapabilities;
    }
  | {
      ok: false;
      reason: FailureReason;
      detail: string;
    };

type FailureReason = "malformed" | "forbidden_field" | "unsupported_protocol";

/**
 * Fields that must never appear in a hello. §6.2 is explicit, and the cost of
 * being wrong is a credential written permanently into the control journal.
 */
const FORBIDDEN_FIELDS = new Set([
  "env",
  "environment",
  "config",
  "settings",
  "apiKey",
  "api_key",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "credential",
  "secret",
  "token",
]);

export function negotiateHello(input: unknown, policy: ServerPolicy): NegotiateResult {
  if (typeof input !== "object" || input === null) {
    return fail("malformed", "hello must be an object");
  }

  const record = input as Record<string, unknown>;

  const forbidden = Object.keys(record).find((key) => FORBIDDEN_FIELDS.has(key));
  if (forbidden !== undefined) {
    return fail("forbidden_field", `hello must not carry "${forbidden}"`);
  }

  if (
    typeof record["protocolVersion"] !== "number" ||
    !Number.isInteger(record["protocolVersion"])
  ) {
    return fail("malformed", "protocolVersion must be an integer");
  }
  if (!isNonEmptyString(record["runnerId"])) {
    return fail("malformed", "runnerId must be a non-empty string");
  }
  if (!isNonEmptyString(record["bootId"])) {
    return fail("malformed", "bootId must be a non-empty string");
  }
  if (
    typeof record["maxConcurrentRuns"] !== "number" ||
    !Number.isInteger(record["maxConcurrentRuns"])
  ) {
    return fail("malformed", "maxConcurrentRuns must be an integer");
  }
  if (record["maxConcurrentRuns"] < 0) {
    return fail("malformed", "maxConcurrentRuns must not be negative");
  }
  if (!Array.isArray(record["activeRuns"])) {
    return fail("malformed", "activeRuns must be an array");
  }
  if (!Array.isArray(record["eventOffsets"])) {
    return fail("malformed", "eventOffsets must be an array");
  }

  const workspaces = parseDeclaredWorkspaces(record["workspaces"]);
  if (workspaces === undefined) {
    return fail("malformed", "workspaces must be an array of {workspaceId, path}");
  }

  const capabilities = parseCapabilities(record["capabilities"]);
  if (capabilities === undefined) {
    return fail("malformed", "capabilities must be an array of strings");
  }

  // §5.2: the models the runner's Claude Code offers, so the composer can list
  // what that host actually has — including custom names the operator
  // configured. Absent is a pre-discovery runner, not an error.
  const models = parseRunnerModels(record["models"]);
  if (models === undefined) {
    return fail("malformed", "models must be an array of model descriptors");
  }

  // §4.1: the discovered command/plugin/MCP/agent catalogue, so the composer
  // and the capabilities dialog can show what this host actually offers. Same
  // reading as models — absent is a pre-discovery runner, not an error.
  const runnerCapabilities = parseRunnerCapabilities(record["runnerCapabilities"]);
  if (runnerCapabilities === undefined) {
    return fail("malformed", "runnerCapabilities must be an object of catalogues");
  }

  const clientVersion = record["protocolVersion"];

  // Refuse a version the server cannot speak. Silently accepting and ignoring
  // unknown fields is how a critical command gets ACKed without being executed.
  if (clientVersion < policy.minProtocolVersion || clientVersion > policy.maxProtocolVersion) {
    return fail(
      "unsupported_protocol",
      `client speaks v${clientVersion}, server supports v${policy.minProtocolVersion}–v${policy.maxProtocolVersion}`,
    );
  }

  return {
    ok: true,
    connectionState: "connected",
    workspaces,
    capabilities,
    models,
    runnerCapabilities,
    negotiation: {
      protocolVersion: policy.maxProtocolVersion,
      policy: {
        // Clamp downward only. The runner may be weaker than the server allows —
        // for example after the operator lowered a desktop's memory budget — and
        // advertising more than it can honour would over-commit the server.
        maxConcurrentRuns: Math.min(record["maxConcurrentRuns"], policy.maxConcurrentRuns),
      },
    },
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Parse the `capabilities` field of a hello. Absent means the runner predates
 * the field and serves none of them (§6.4 back-compat) — the same reading as
 * `parseDeclaredWorkspaces`. Anything present but outside the shape is
 * malformed: a `capabilities: "inspect"` accepted by coercion would let a
 * runner advertise a feature by accident of a typo.
 */
export function parseCapabilities(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const capabilities: string[] = [];
  for (const entry of value) {
    if (!isNonEmptyString(entry)) return undefined;
    if (!capabilities.includes(entry)) capabilities.push(entry);
  }
  return capabilities;
}

/**
 * Compose the four catalogue parsers over the hello's `runnerCapabilities`
 * field. The field itself must be an object when present — an array or a
 * string is a shape violation, not an empty catalogue — while each sub-list is
 * parsed by its own parser, whose `undefined` (non-array) propagates as
 * malformed. Absent is a pre-discovery runner: every sub-parser then reads an
 * absent field as an empty list.
 */
function parseRunnerCapabilities(value: unknown): RunnerCapabilities | undefined {
  if (value === undefined) {
    return { commands: [], plugins: [], mcpServers: [], agents: [] };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const commands = parseRunnerCommands(record["commands"]);
  if (commands === undefined) return undefined;
  const plugins = parseRunnerPlugins(record["plugins"]);
  if (plugins === undefined) return undefined;
  const mcpServers = parseRunnerMcpServers(record["mcpServers"]);
  if (mcpServers === undefined) return undefined;
  const agents = parseRunnerAgents(record["agents"]);
  if (agents === undefined) return undefined;
  return { commands, plugins, mcpServers, agents };
}

function fail(reason: FailureReason, detail: string): NegotiateResult {
  return { ok: false, reason, detail };
}
