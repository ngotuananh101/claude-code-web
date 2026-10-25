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

function fail(reason: FailureReason, detail: string): NegotiateResult {
  return { ok: false, reason, detail };
}
