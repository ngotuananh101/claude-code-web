import type { Database } from "bun:sqlite";
import type {
  ModelMapping,
  ProfileAuthField,
  ProfileDetail,
  ProfileSummary,
} from "@cc-web/protocol";

/**
 * Upstream provider profiles (§17.1 / §18.1, P3-C).
 *
 * A profile binds a session's dispatch to an alternate upstream endpoint (such
 * as a 9Router gateway) with a remapped model role table and a Claude Code
 * settings overlay. Profiles are owned by a single user and never shared across
 * owners.
 *
 * The repository stores the raw API key in the `api_key_encrypted` column — in
 * a production deployment that caller (the control server) is the key holder
 * and encrypts before calling in; the column name preserves that contract.
 * This layer never returns the cleartext key to browser-facing listings: it
 * only hands the raw secret back to the single internal caller that dispatches
 * a run (`getProfileWithSecret`).
 */

/** Raw row as persisted in `config_profiles`. */
type ProfileRow = {
  id: string;
  owner_id: string;
  name: string;
  endpoint: string;
  auth_field: string;
  api_key_encrypted: string | null;
  model_mapping: string;
  settings_json: string;
  created_at: number;
  updated_at: number;
};

/** Fields required to create a new profile. */
export type CreateProfileInput = {
  ownerId: string;
  name: string;
  endpoint: string;
  authField: ProfileAuthField;
  apiKey?: string;
  modelMapping?: ModelMapping;
  settingsJson: string;
};

/** The subset of a profile returned to the creator. */
export type CreatedProfile = {
  id: string;
  name: string;
};

/** Patch fields for an in-place profile update. */
export type UpdateProfilePatch = {
  name?: string;
  endpoint?: string;
  authField?: ProfileAuthField;
  apiKey?: string;
  modelMapping?: ModelMapping;
  settingsJson?: string;
};

/**
 * The full profile with its cleartext secret, returned only to the internal
 * dispatch path that forwards a `RunProfilePayload` to a runner.
 */
export type ProfileWithSecret = {
  id: string;
  ownerId: string;
  name: string;
  endpoint: string;
  authField: ProfileAuthField;
  apiKey: string | undefined;
  modelMapping: ModelMapping;
  settings: Record<string, unknown>;
};

/**
 * Mask a cleartext key for display: keep the prefix and suffix, redact the
 * middle. Returns `undefined` when no key is present so the edit form can
 * render a "set / unset" affordance without leaking length.
 */
function maskApiKey(key: string | null | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length <= 6) return `${key.slice(0, 1)}***${key.slice(-1)}`;
  return `${key.slice(0, 3)}***${key.slice(-3)}`;
}

/** True when a stored key is non-null and non-empty. */
function hasKey(key: string | null | undefined): boolean {
  return typeof key === "string" && key.length > 0;
}

/** Parse a JSON column into a record, falling back to `{}` on any failure. */
function parseJsonColumn(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function createProfile(db: Database, input: CreateProfileInput): CreatedProfile {
  const now = Date.now();
  const id = `prof_${randomId()}`;
  const apiKey = input.apiKey ?? null;
  const modelMapping = input.modelMapping ?? {};

  db.prepare(
    `INSERT INTO config_profiles
       (id, owner_id, name, endpoint, auth_field, api_key_encrypted, model_mapping, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.ownerId,
    input.name.trim(),
    input.endpoint,
    input.authField,
    apiKey,
    JSON.stringify(modelMapping),
    input.settingsJson,
    now,
    now,
  );

  return { id, name: input.name.trim() };
}

export function getProfileById(db: Database, id: string, ownerId: string): ProfileDetail | null {
  const row = db
    .prepare(
      `SELECT id, owner_id, name, endpoint, auth_field, api_key_encrypted, model_mapping, settings_json
         FROM config_profiles
        WHERE id = ? AND owner_id = ?`,
    )
    .get(id, ownerId) as ProfileRow | null | undefined;

  if (!row) return null;
  return toDetail(row);
}

export function getProfileWithSecret(
  db: Database,
  id: string,
  ownerId: string,
): ProfileWithSecret | null {
  const row = db
    .prepare(
      `SELECT id, owner_id, name, endpoint, auth_field, api_key_encrypted, model_mapping, settings_json
         FROM config_profiles
        WHERE id = ? AND owner_id = ?`,
    )
    .get(id, ownerId) as ProfileRow | null | undefined;

  if (!row) return null;

  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    endpoint: row.endpoint,
    authField: row.auth_field as ProfileAuthField,
    apiKey: row.api_key_encrypted ?? undefined,
    modelMapping: parseJsonColumn(row.model_mapping) as ModelMapping,
    settings: parseJsonColumn(row.settings_json),
  };
}

export function listProfilesForOwner(db: Database, ownerId: string): ProfileSummary[] {
  const rows = db
    .prepare(
      `SELECT id, name, endpoint, auth_field, api_key_encrypted, model_mapping
         FROM config_profiles
        WHERE owner_id = ?
         ORDER BY updated_at DESC`,
    )
    .all(ownerId) as Array<{
    id: string;
    name: string;
    endpoint: string;
    auth_field: string;
    api_key_encrypted: string | null;
    model_mapping: string;
  }>;

  return rows.map((row) => {
    const summary: ProfileSummary = {
      profileId: row.id,
      name: row.name,
      endpoint: row.endpoint,
      authField: row.auth_field as ProfileAuthField,
      hasKey: hasKey(row.api_key_encrypted),
    };
    const mapping = parseJsonColumn(row.model_mapping) as ModelMapping;
    if (Object.keys(mapping).length > 0) {
      summary.modelMapping = mapping;
    }
    return summary;
  });
}

export function updateProfile(
  db: Database,
  id: string,
  ownerId: string,
  patch: UpdateProfilePatch,
): boolean {
  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (patch.name !== undefined) {
    updates.push(`name = ?`);
    values.push(patch.name.trim());
  }
  if (patch.endpoint !== undefined) {
    updates.push(`endpoint = ?`);
    values.push(patch.endpoint);
  }
  if (patch.authField !== undefined) {
    updates.push(`auth_field = ?`);
    values.push(patch.authField);
  }
  if (patch.apiKey !== undefined) {
    updates.push(`api_key_encrypted = ?`);
    values.push(patch.apiKey === "" ? null : patch.apiKey);
  }
  if (patch.modelMapping !== undefined) {
    updates.push(`model_mapping = ?`);
    values.push(JSON.stringify(patch.modelMapping));
  }
  if (patch.settingsJson !== undefined) {
    updates.push(`settings_json = ?`);
    values.push(patch.settingsJson);
  }

  if (updates.length === 0) return false;

  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE config_profiles SET ${updates.join(", ")}, updated_at = ?
     WHERE id = ? AND owner_id = ?`,
    )
    .run(...(values as (string | number | null)[]), now, id, ownerId);

  return result.changes > 0;
}

export function deleteProfile(db: Database, id: string, ownerId: string): boolean {
  const result = db
    .prepare("DELETE FROM config_profiles WHERE id = ? AND owner_id = ?")
    .run(id, ownerId);
  return result.changes > 0;
}

/** Map a raw row into the browser-facing masked detail. */
function toDetail(row: ProfileRow): ProfileDetail {
  const detail: ProfileDetail = {
    profileId: row.id,
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    authField: row.auth_field as ProfileAuthField,
    hasKey: hasKey(row.api_key_encrypted),
    settings: parseJsonColumn(row.settings_json),
  };
  const masked = maskApiKey(row.api_key_encrypted);
  if (masked !== undefined) {
    detail.apiKeyMasked = masked;
  }
  const mapping = parseJsonColumn(row.model_mapping) as ModelMapping;
  if (Object.keys(mapping).length > 0) {
    detail.modelMapping = mapping;
  }
  return detail;
}

/** Generate a random id component for profile ids (crypto-grade, url-safe). */
function randomId(): string {
  // crypto.randomUUID without dashes, truncated to 16 chars ≈ 10 bytes of entropy.
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}
