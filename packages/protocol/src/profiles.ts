/**
 * Upstream provider profiles and Claude Code settings overrides (§17.1, §18.1).
 *
 * A `RunProfilePayload` carries everything a Control Server needs to tell a
 * runner which upstream endpoint to talk to, which credential to use there,
 * and how the Claude Code model roles should be remapped for that single run.
 * Profiles are applied strictly per session at turn dispatch time; a session
 * that does not select one falls back to the runner host's native configuration.
 *
 * These are application-level wire types, deliberately independent of raw SDK
 * types — see ARCHITECTURE.md §9/§17.
 */

/**
 * The env-var name the executor must set to deliver a profile's upstream API key.
 *
 * `ANTHROPIC_AUTH_TOKEN` is the standard header for gate-way proxies (e.g. 9Router,
 * One API); `ANTHROPIC_API_KEY` is the standard header for official Anthropic
 * endpoints. The executor sets `env[authField] = apiKey`.
 */
export type ProfileAuthField = "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";

/**
 * The closed set of Claude Code model roles a profile may remap.
 *
 * Each maps to a distinct env var at dispatch time:
 * - `sonnet`  -> `ANTHROPIC_DEFAULT_SONNET_MODEL`
 * - `opus`    -> `ANTHROPIC_DEFAULT_OPUS_MODEL`
 * - `haiku`   -> `ANTHROPIC_DEFAULT_HAIKU_MODEL`
 * - `fable`   -> `ANTHROPIC_DEFAULT_FABLE_MODEL`
 * - `subagent` -> `CLAUDE_CODE_SUBAGENT_MODEL`
 */
export const MODEL_ROLES = ["sonnet", "opus", "haiku", "fable", "subagent"] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * An optional per-role model name remap. All fields are optional so a profile
 * may map only the roles it cares about; unmapped roles fall back to the host.
 */
export type ModelMapping = Partial<Record<ModelRole, string>>;

/**
 * The full profile payload dispatched to a runner inside a `run.start` command.
 *
 * `apiKey` is delivered over the authenticated WebSocket frame and redacted in
 * command outbox / event persistence where the profile is journaled.
 */
export type RunProfilePayload = {
  profileId: string;
  name: string;
  endpoint: string;
  authField: ProfileAuthField;
  apiKey?: string;
  modelMapping?: ModelMapping;
  settings?: Record<string, unknown>;
};

/**
 * The browser-facing summary of a profile (list view): the secret is present
 * only as a presence flag so the cleartext key never reaches the browser.
 */
export type ProfileSummary = {
  profileId: string;
  name: string;
  endpoint: string;
  authField: ProfileAuthField;
  modelMapping?: ModelMapping;
  hasKey: boolean;
};

/**
 * The browser-facing detail of a profile (edit form): the secret is delivered
 * masked or omitted; the control API never returns the cleartext `apiKey` here.
 */
export type ProfileDetail = ProfileSummary & {
  id: string;
  /** Masked representation sent only for display in the edit form. */
  apiKeyMasked?: string;
  settings?: Record<string, unknown>;
};

/**
 * Read a value as a plain record, returning `undefined` for non-objects and
 * arrays. Used at the untrusted boundary where wire data may be anything.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A non-empty trimmed string of at most `max` characters, else undefined. */
function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() !== "" && value.length <= max
    ? value
    : undefined;
}

const MODEL_ROLE_SET = new Set(MODEL_ROLES);

/**
 * Parse an unknown value into a `ModelMapping`, returning `undefined` when the
 * value is malformed.
 *
 * `undefined` is read as "absent" and yields an empty mapping — a session that
 * carries no model override must not render the whole payload unparseable.
 * Unknown role keys make the mapping `undefined` (malformed): a role nobody
 * defined cannot ride along, matching the closed-set contract.
 */
export function parseModelMapping(value: unknown): ModelMapping | undefined {
  if (value === undefined) return {};
  const record = asRecord(value);
  if (record === undefined) return undefined;

  const mapping: ModelMapping = {};
  for (const [role, raw] of Object.entries(record)) {
    if (!MODEL_ROLE_SET.has(role as ModelRole)) return undefined;
    const label = boundedString(raw, 200);
    if (label === undefined) return undefined;
    mapping[role as ModelRole] = raw as string;
  }
  return mapping;
}

/**
 * Parse an unknown value into a `RunProfilePayload`, returning `undefined`
 * when the value does not match the expected shape.
 *
 * Required fields (`profileId`, `name`, `endpoint`, `authField`) must be valid
 * if present; `apiKey` is optional (omitted when masked in listings); the
 * `endpoint` must be an http/https URL; unknown keys are dropped so a field
 * nobody defined cannot ride along.
 */
export function parseRunProfilePayload(value: unknown): RunProfilePayload | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;

  const profileId = boundedString(record["profileId"], 200);
  const name = boundedString(record["name"], 200);
  const endpoint = boundedString(record["endpoint"], 2048);
  const authField = record["authField"];

  if (profileId === undefined || name === undefined || endpoint === undefined) return undefined;
  if (authField !== "ANTHROPIC_AUTH_TOKEN" && authField !== "ANTHROPIC_API_KEY") return undefined;
  if (!isHttpUrl(endpoint)) return undefined;

  const result: RunProfilePayload = { profileId, name, endpoint, authField };

  const apiKey = record["apiKey"];
  if (typeof apiKey === "string" && apiKey !== "") {
    result.apiKey = apiKey;
  } else if (apiKey !== undefined && apiKey !== null) {
    return undefined;
  }

  const modelMapping = parseModelMapping(record["modelMapping"]);
  if (record["modelMapping"] !== undefined && modelMapping === undefined) return undefined;
  if (modelMapping !== undefined && Object.keys(modelMapping).length > 0) {
    result.modelMapping = modelMapping;
  }

  const settings = record["settings"];
  if (settings !== undefined) {
    if (asRecord(settings) === undefined) return undefined;
    result.settings = settings as Record<string, unknown>;
  }

  return result;
}

/** True when `value` is a non-empty `http:` or `https:` URL string. */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
