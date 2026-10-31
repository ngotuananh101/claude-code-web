import type { Database } from "bun:sqlite";
import {
  createProfile,
  deleteProfile,
  getProfileById,
  getProfileWithSecret,
  listProfilesForOwner,
  maskApiKey,
  updateProfile,
} from "@cc-web/control-db";
import { type ModelMapping, type ProfileAuthField, parseModelMapping } from "@cc-web/protocol";
import type { SecretBox } from "../config/secret-box.ts";

/**
 * Owner-scoped profile management over HTTP (§17.1, §18.1, P3-C).
 *
 * Five handlers cover CRUD for `/api/config/profiles[/:id]` under a single auth
 * seam: Origin allowlist, then session cookie. The `authorized` object is passed
 * in by the server layer (which owns the `BrowserGateway`); each handler trusts
 * it as proof of ownership rather than re-authenticating.
 *
 * Validation rules (spec §7):
 *  - `name` must be a non-empty trimmed string.
 *  - `endpoint` must parse as an http: or https: URL.
 *  - `authField` must be one of the two protocol values.
 *  - `modelMapping` must only contain MODEL_ROLES keys with non-empty string values.
 *  - `settingsJson` must be valid JSON object (defaults to `{}` when omitted).
 *
 * Profile ID is extracted from the request URL for GET/PUT/DELETE handlers.
 */

type AuthorizedUser = { userId: string; username?: string };

type ConfigOptions = { db: Database; secretBox: SecretBox };

/**
 * Extract the profile id from a request URL of the form
 * `http://host/api/config/profiles/:id`.
 */
function extractProfileId(request: Request): string {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/config\/profiles\/(.+)$/);
  return decodeURIComponent(match?.[1] ?? "");
}

/**
 * Validate a profile name: non-empty after trimming.
 */
function validateName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed !== "" ? trimmed : undefined;
}

/**
 * Validate an endpoint: must be a valid http/https URL.
 */
function validateEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return value;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validate an auth field: must be one of the two protocol values.
 */
function validateAuthField(value: unknown): ProfileAuthField | undefined {
  if (value === "ANTHROPIC_AUTH_TOKEN" || value === "ANTHROPIC_API_KEY") {
    return value;
  }
  return undefined;
}

/**
 * Validate modelMapping: must only contain model role keys with non-empty
 * string values. Returns an empty mapping for undefined, or undefined if invalid.
 */
function validateModelMapping(value: unknown): ModelMapping | undefined {
  if (value === undefined) return {};
  const parsed = parseModelMapping(value);
  if (parsed === undefined) return undefined;
  // parseModelMapping enforces the closed set of roles and string type; reject
  // empty-string values as well.
  for (const val of Object.values(parsed)) {
    if (val === undefined || typeof val !== "string" || val.trim() === "") return undefined;
  }
  return parsed;
}

/**
 * Validate settingsJson: must be valid JSON representing a plain object.
 * Returns the raw JSON string if valid, or undefined if invalid.
 * Defaults to "{}" when omitted.
 */
function validateSettingsJson(value: unknown): string | undefined {
  if (value === undefined) return "{}";
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

type ParsedProfileBody = {
  name: string;
  endpoint: string;
  authField: ProfileAuthField;
  apiKey: string | undefined;
  modelMapping: ModelMapping;
  settingsJson: string;
  apiKeyPresent: boolean;
};

/**
 * Parse and validate a profile body from the request. Returns either a parsed
 * body object or an error Response. When `isUpdate` is true, an absent apiKey
 * means "preserve the stored key".
 */
async function parseProfileBody(
  request: Request,
  isUpdate: boolean,
): Promise<{ body: ParsedProfileBody } | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("BAD_REQUEST", "invalid JSON body", 400);
  }

  if (typeof body !== "object" || body === null) {
    return jsonError("BAD_REQUEST", "request body must be a JSON object", 400);
  }

  const record = body as Record<string, unknown>;

  const name = validateName(record["name"]);
  const endpoint = validateEndpoint(record["endpoint"]);
  const authField = validateAuthField(record["authField"]);
  const modelMapping = validateModelMapping(record["modelMapping"]);
  const settingsJson = validateSettingsJson(record["settingsJson"]);

  const errors: string[] = [];
  if (name === undefined) errors.push("name must be a non-empty string");
  if (endpoint === undefined) errors.push("endpoint must be a valid http(s) URL");
  if (authField === undefined) {
    errors.push("authField must be ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY");
  }
  if (modelMapping === undefined) {
    errors.push(
      "modelMapping must only contain valid model role keys with non-empty string values",
    );
  }
  if (settingsJson === undefined) {
    errors.push("settingsJson must be a valid JSON object string");
  }

  if (errors.length > 0) {
    return jsonError("BAD_REQUEST", errors.join("; "), 400);
  }

  // apiKey: for create it's optional; for update, absent means "preserve".
  let apiKey: string | undefined;
  let apiKeyPresent = false;
  if ("apiKey" in record) {
    apiKeyPresent = true;
    if (typeof record["apiKey"] === "string") {
      apiKey = record["apiKey"];
    } else if (record["apiKey"] !== undefined && record["apiKey"] !== null) {
      return jsonError("BAD_REQUEST", "apiKey must be a string", 400);
    } else {
      apiKey = undefined;
    }
  }

  return {
    body: {
      name: name!,
      endpoint: endpoint!,
      authField: authField!,
      apiKey,
      modelMapping: modelMapping!,
      settingsJson: settingsJson!,
      apiKeyPresent: isUpdate ? apiKeyPresent : true,
    },
  };
}

function jsonError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * `GET /api/config/profiles`
 *
 * Returns the list of profiles for the authenticated owner. Each summary carries
 * `hasKey` (boolean presence flag) but never the raw API key.
 */
export async function handleListProfiles(
  _request: Request,
  options: ConfigOptions,
  authorized: AuthorizedUser,
): Promise<Response> {
  const profiles = listProfilesForOwner(options.db, authorized.userId);
  return new Response(JSON.stringify(profiles), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * `GET /api/config/profiles/:id`
 *
 * Returns a single browser-facing profile detail. The API key is never returned
 * in cleartext — only `apiKeyMasked` (if present) and `hasKey`. If the sealed
 * value cannot be opened (wrong key, tampered), `apiKeyMasked` is omitted but
 * `hasKey` stays true so the edit form can offer a "set / unset" affordance.
 */
export async function handleGetProfile(
  request: Request,
  options: ConfigOptions,
  authorized: AuthorizedUser,
): Promise<Response> {
  const profileId = extractProfileId(request);
  const withSecret = getProfileWithSecret(options.db, profileId, authorized.userId);
  if (withSecret === null) {
    return new Response("not found", { status: 404 });
  }

  const detail = getProfileById(options.db, profileId, authorized.userId);
  if (detail === null) {
    return new Response("not found", { status: 404 });
  }

  // Re-derive the mask from the cleartext, not from the stored sealed string.
  // If the seal cannot be opened, omit apiKeyMasked but keep hasKey.
  if (withSecret.apiKey !== undefined) {
    const plain = options.secretBox.open(withSecret.apiKey);
    if (plain !== null) {
      detail.apiKeyMasked = maskApiKey(plain)!;
    }
  }

  return new Response(JSON.stringify(detail), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * `POST /api/config/profiles`
 *
 * Creates a new profile for the authenticated owner. Returns the created
 * profile's id and name.
 */
export async function handleCreateProfile(
  request: Request,
  options: ConfigOptions,
  authorized: AuthorizedUser,
): Promise<Response> {
  const result = await parseProfileBody(request, false);
  if (result instanceof Response) return result;

  const { name, endpoint, authField, apiKey, modelMapping, settingsJson } = result.body;

  // Seal a non-empty apiKey before it touches the database. An empty string
  // means "no key" and is passed as undefined so the column stays NULL.
  const sealedKey =
    apiKey !== undefined && apiKey !== "" ? options.secretBox.seal(apiKey) : undefined;

  const created = createProfile(options.db, {
    ownerId: authorized.userId,
    name,
    endpoint,
    authField,
    ...(sealedKey !== undefined ? { apiKey: sealedKey } : {}),
    modelMapping,
    settingsJson,
  });

  return new Response(JSON.stringify(created), {
    status: 201,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * `PUT /api/config/profiles/:id`
 *
 * Updates an existing profile. When `apiKey` is omitted from the request body, the
 * previously stored key is preserved.
 */
export async function handleUpdateProfile(
  request: Request,
  options: ConfigOptions,
  authorized: AuthorizedUser,
): Promise<Response> {
  const profileId = extractProfileId(request);
  const result = await parseProfileBody(request, true);
  if (result instanceof Response) return result;

  const { name, endpoint, authField, apiKey, modelMapping, settingsJson, apiKeyPresent } =
    result.body;

  // Verify ownership before updating.
  const existed = getProfileById(options.db, profileId, authorized.userId);
  if (existed === null) {
    return new Response("not found", { status: 404 });
  }

  // When the body supplies an apiKey field: a non-empty value is sealed before
  // persistence; an empty string clears the stored key.
  let patchApiKey: string | undefined;
  if (apiKeyPresent) {
    patchApiKey = apiKey === undefined || apiKey === "" ? "" : options.secretBox.seal(apiKey);
  }

  const updated = updateProfile(options.db, profileId, authorized.userId, {
    name,
    endpoint,
    authField,
    ...(patchApiKey !== undefined ? { apiKey: patchApiKey } : {}),
    modelMapping,
    settingsJson,
  });

  if (!updated) {
    return new Response("not found", { status: 404 });
  }

  // Return the freshly-masked detail so the browser sees the new mask.
  const withSecret = getProfileWithSecret(options.db, profileId, authorized.userId);
  const detail = getProfileById(options.db, profileId, authorized.userId);
  if (detail !== null && withSecret !== null && withSecret.apiKey !== undefined) {
    const plain = options.secretBox.open(withSecret.apiKey);
    if (plain !== null) {
      detail.apiKeyMasked = maskApiKey(plain)!;
    }
  }
  return new Response(JSON.stringify(detail), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * `DELETE /api/config/profiles/:id`
 *
 * Deletes a profile. Returns 404 if the profile does not exist or is not owned
 * by the authenticated user.
 */
export async function handleDeleteProfile(
  request: Request,
  options: ConfigOptions,
  authorized: AuthorizedUser,
): Promise<Response> {
  const profileId = extractProfileId(request);

  const existed = getProfileById(options.db, profileId, authorized.userId);
  if (existed === null) {
    return new Response("not found", { status: 404 });
  }

  const deleted = deleteProfile(options.db, profileId, authorized.userId);
  if (!deleted) {
    return new Response("not found", { status: 404 });
  }

  return new Response(JSON.stringify({ ok: true, id: profileId }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
