/**
 * Pure, Vue-free two-way sync between the profiles visual form and the Claude
 * Code settings JSON editor (§4.5 / design doc §7.4 "Two-Way Form/JSON Sync").
 *
 * The visual form owns the primary profile fields: `name`, `endpoint`,
 * `apiKey`, `authField`, and `modelMapping`. Those map onto a Claude Code
 * settings object whose `env` block carries the upstream endpoint, the auth
 * credential under the chosen header var, and the per-role model remaps. Any
 * settings the form doesn't own (e.g. `permissions`) are preserved verbatim
 * across a `formToJson` regeneration when provided as the second argument, and
 * the inverse direction `jsonToForm` reads those back as `settingsJson`.
 */

import type {
  ModelMapping,
  ModelRole,
  ProfileAuthField,
  ProfileDetail,
  ProfileSummary,
} from "@cc-web/protocol";

/**
 * The env-var names Claude Code reads, keyed by the model role a profile maps.
 * Matches the closed set enforced by the protocol layer (§7.6).
 */
const MODEL_ROLE_ENV: Record<ModelRole, string> = {
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
  subagent: "CLAUDE_CODE_SUBAGENT_MODEL",
};

/** The auth-field env var a profile's API key is delivered under. */
const AUTH_ENV = "ANTHROPIC_AUTH_TOKEN";
const API_KEY_ENV = "ANTHROPIC_API_KEY";
/** The env var Claude Code reads as the upstream base URL. */
const BASE_URL_ENV = "ANTHROPIC_BASE_URL";

/** The full set of model-role keys, for filtering stray env entries. */
const MODEL_ROLE_KEYS = Object.keys(MODEL_ROLE_ENV) as ModelRole[];

/**
 * Every env var the visual form owns and regenerates from a form field. The
 * editor keeps every other env entry verbatim — a proxy URL the operator typed
 * into the JSON side is not the form's to drop.
 */
const FORM_OWNED_ENV: ReadonlySet<string> = new Set([
  BASE_URL_ENV,
  AUTH_ENV,
  API_KEY_ENV,
  ...Object.values(MODEL_ROLE_ENV),
]);

/** The visual form's primary fields. */
export interface ProfileForm {
  name: string;
  endpoint: string;
  apiKey: string;
  authField: ProfileAuthField;
  modelMapping: ModelMapping;
}

/**
 * A result of parsing settings JSON. The form owns a known subset; `settingsJson`
 * carries the remainder (permissions, model, effort, etc.) so a round-trip does
 * not drop fields the visual form has no input for.
 */
export interface ParsedSettings {
  /** `env.*` owned by the visual form, re-extracted back into form fields. */
  env: Record<string, string>;
  /** Whatever else sat at the top level of the settings object. */
  settingsJson: string;
}

/**
 * Serialize the visual form into a Claude Code settings JSON string.
 *
 * `extra` is an optional pre-existing settings object whose non-`env` fields
 * are preserved alongside the regenerated `env` block, so toggling a model
 * mapping or endpoint doesn't wipe a user's `permissions` block.
 */
export function formToJson(form: ProfileForm, extra?: Record<string, unknown>): string {
  const env: Record<string, string> = {
    [BASE_URL_ENV]: form.endpoint,
  };

  // The credential always lands under the auth field the operator chose.
  if (form.apiKey !== "") {
    const key = form.authField === "ANTHROPIC_API_KEY" ? API_KEY_ENV : AUTH_ENV;
    env[key] = form.apiKey;
  }

  // Only emit env vars for roles the form actually maps (omits undefined).
  for (const role of MODEL_ROLE_KEYS) {
    const mapped = (form.modelMapping as Record<string, string | undefined>)[role];
    if (mapped !== undefined && mapped !== "") {
      env[MODEL_ROLE_ENV[role]] = mapped;
    }
  }

  const merged = mergeSettings(extra, env);
  return JSON.stringify(merged, null, 2);
}

/**
 * Split a settings object into the part the visual form does not own: every
 * top-level key plus the `env` entries whose var no form field drives. The
 * result is what `formToJson` takes as its `extra`, so custom env entries (a
 * proxy, a feature flag) survive a form edit instead of being dropped, while
 * the form-owned env keys are left for the form to regenerate.
 *
 * An `env` block left with no custom entries is omitted rather than emitted
 * empty, so a profile with only form-owned settings saves as `{}`.
 */
export function formFreeSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key !== "env") result[key] = value;
  }

  const env = settings["env"];
  if (typeof env === "object" && env !== null && !Array.isArray(env)) {
    const custom: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (!FORM_OWNED_ENV.has(key)) custom[key] = value;
    }
    if (Object.keys(custom).length > 0) result["env"] = custom;
  }
  return result;
}

/**
 * Merge a regenerated `env` block into an existing settings object, preserving
 * every top-level key the form does not own and every custom env entry. The
 * regenerated env wins on the keys the form owns.
 */
function mergeSettings(
  extra: Record<string, unknown> | undefined,
  env: Record<string, string>,
): Record<string, unknown> {
  const rest = formFreeSettings(extra ?? {});
  const customEnv = (rest["env"] as Record<string, unknown> | undefined) ?? {};
  return { ...rest, env: { ...customEnv, ...env } };
}

/**
 * Parse settings JSON back into the visual form, reading the known `env` vars
 * onto the form fields and the remainder onto `settingsJson`.
 *
 * Throws `SyntaxError` when the JSON is invalid — callers (and the editor)
 * surface that as the syntax-error badge.
 */
export function jsonToForm(json: string): ProfileForm & { settingsJson: string } {
  const parsed: unknown = JSON.parse(json);
  const record = (
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>;

  const env = (record["env"] ?? {}) as Record<string, unknown>;
  const envStrings: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") envStrings[k] = v;
  }

  const endpoint = extractString(envStrings, BASE_URL_ENV);

  const authToken = envStrings[AUTH_ENV];
  const apiKey = envStrings[API_KEY_ENV];
  let authField: ProfileAuthField = "ANTHROPIC_AUTH_TOKEN";
  let credential = "";
  if (typeof authToken === "string" && authToken !== "") {
    authField = "ANTHROPIC_AUTH_TOKEN";
    credential = authToken;
  } else if (typeof apiKey === "string" && apiKey !== "") {
    authField = "ANTHROPIC_API_KEY";
    credential = apiKey;
  }

  const modelMapping: ModelMapping = {};
  for (const [role, envVar] of Object.entries(MODEL_ROLE_ENV)) {
    const value = envStrings[envVar];
    if (typeof value === "string" && value !== "") {
      modelMapping[role as ModelRole] = value;
    }
  }

  // Carry the fields the visual form does not own (permissions, model, etc.),
  // including any custom env entries the JSON side holds.
  const remainder: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key !== "env") remainder[key] = record[key];
  }
  const customEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(envStrings)) {
    if (!FORM_OWNED_ENV.has(key)) customEnv[key] = value;
  }
  if (Object.keys(customEnv).length > 0) remainder["env"] = customEnv;
  const settingsJson =
    Object.keys(remainder).length > 0 ? JSON.stringify(remainder, null, 2) : "{}";

  return {
    name: extractString(record, "name") ?? "",
    endpoint: endpoint ?? "",
    apiKey: credential,
    authField,
    modelMapping,
    settingsJson,
  };
}

function extractString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Seed the visual form from a profile detail. The credential field always
 * starts empty: the server only ever sends the key masked, and an empty input
 * beside `hasKey` is the editor's "keep the stored key" state (§4.2).
 */
export function profileFormFromDetail(
  detail: Pick<ProfileDetail, "name" | "endpoint" | "authField" | "modelMapping">,
): ProfileForm {
  return {
    name: detail.name,
    endpoint: detail.endpoint,
    apiKey: "",
    authField: detail.authField,
    modelMapping: detail.modelMapping ?? {},
  };
}

/** The PUT/POST body the profiles screen sends for a save. */
export interface ProfileSaveBody {
  name: string;
  endpoint: string;
  authField: ProfileAuthField;
  apiKey?: string;
  modelMapping: ModelMapping;
  settingsJson?: string;
}

/**
 * Build the save body from the editor state. An empty credential input means
 * "keep the stored key" (§4.2), so the field is omitted rather than posted as
 * an empty string; an empty settings remainder is omitted for the same reason.
 */
export function profileSaveBody(
  form: ProfileForm,
  extra?: Record<string, unknown>,
): ProfileSaveBody {
  return {
    name: form.name,
    endpoint: form.endpoint,
    authField: form.authField,
    ...(form.apiKey === "" ? {} : { apiKey: form.apiKey }),
    modelMapping: form.modelMapping,
    ...(extra !== undefined && Object.keys(extra).length > 0
      ? { settingsJson: JSON.stringify(extra) }
      : {}),
  };
}

/**
 * The profile the editor should show after a list refresh: the current
 * selection when it still exists, otherwise the first profile, otherwise none
 * (the screen starts a new profile).
 */
export function nextSelectedProfileId(
  profiles: Array<Pick<ProfileSummary, "profileId">>,
  current: string | null,
): string | null {
  if (current !== null && profiles.some((profile) => profile.profileId === current)) {
    return current;
  }
  return profiles[0]?.profileId ?? null;
}

/**
 * Validate the JSON editor's contents. The settings must parse and be a plain
 * object (Claude Code rejects arrays/null scalars as a settings document).
 */
export function validateSettingsJson(
  json: string,
): { valid: true } | { valid: false; error: string } {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { valid: false, error: "Cấu hình phải là một đối tượng JSON." };
    }
    return { valid: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "JSON không hợp lệ.";
    return { valid: false, error: message };
  }
}
