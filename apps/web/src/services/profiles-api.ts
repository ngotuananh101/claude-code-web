/**
 * Profiles management HTTP half (§4.5 / §4.2).
 *
 * Thin fetch wrapper around `/api/config/profiles`, modeled on
 * `runners-api.ts` and `schedules-api.ts`: `authFetch` carries the session
 * cookie, ids are URL-encoded, transport/parse failures fold into the one
 * outcome shape the view can branch on, and 401 is surfaced as a distinct
 * `unauthorized` code so the rail's auth flow can react.
 */

import type {
  ModelMapping,
  ProfileAuthField,
  ProfileDetail,
  ProfileSummary,
} from "@cc-web/protocol";
import { t } from "@/lib/i18n";
import { authFetch } from "./auth-api.ts";

export type CreateProfileBody = {
  name: string;
  endpoint: string;
  authField: ProfileAuthField;
  apiKey?: string;
  modelMapping?: ModelMapping;
  settingsJson?: string;
};

export type UpdateProfileBody = CreateProfileBody;

export type ListProfilesResult =
  | { ok: true; profiles: ProfileSummary[] }
  | { ok: false; code: "unauthorized" | "error"; message: string };

export type ProfileResult =
  | { ok: true; profile: ProfileDetail }
  | { ok: false; code: "unauthorized" | "not_found" | "error"; message: string };

export type SaveProfileResult =
  | { ok: true; profile: ProfileDetail }
  | { ok: false; code: "unauthorized" | "error"; message: string };

export type DeleteProfileResult = "deleted" | "not_found" | "unauthorized" | "error";

/**
 * Ask the control server to read a gateway's model catalogue. The api key never
 * reaches the browser, so the server resolves it from the typed value or the
 * sealed secret behind `profileId`, then calls `{endpoint}/models` itself.
 */
export type ProfileModelsBody = {
  endpoint?: string;
  authField?: ProfileAuthField;
  apiKey?: string;
  profileId?: string;
};

export type ProfileModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; code: "unauthorized" | "error"; message: string };

export async function fetchProfileModels(body: ProfileModelsBody): Promise<ProfileModelsResult> {
  let response: Response;
  try {
    response = await authFetch("/api/config/profiles/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, code: "error", message: t("api.unreachableTo") };
  }

  if (response.status === 401) {
    return { ok: false, code: "unauthorized", message: t("api.sessionExpired") };
  }
  if (!response.ok) {
    return { ok: false, code: "error", message: await errorMessage(response) };
  }

  try {
    const parsed = (await response.json()) as { models?: unknown };
    if (!Array.isArray(parsed.models)) {
      return { ok: false, code: "error", message: t("api.invalidModelListResponse") };
    }
    return {
      ok: true,
      models: parsed.models.filter((model): model is string => typeof model === "string"),
    };
  } catch {
    return { ok: false, code: "error", message: t("api.invalidModelListResponse") };
  }
}

/**
 * Fetch the authenticated owner's profiles. The cleartext API key never
 * crosses this boundary — the server returns a presence flag (`hasKey`) plus a
 * masked representation on the detail.
 */
export async function listProfiles(): Promise<ListProfilesResult> {
  let response: Response;
  try {
    response = await authFetch("/api/config/profiles");
  } catch {
    return { ok: false, code: "error", message: t("api.unreachableTo") };
  }

  if (response.status === 401) {
    return { ok: false, code: "unauthorized", message: t("api.sessionExpired") };
  }
  if (!response.ok) {
    return { ok: false, code: "error", message: await text(response) };
  }

  try {
    const body = (await response.json()) as { profiles?: unknown };
    if (!Array.isArray(body.profiles)) {
      return { ok: false, code: "error", message: t("api.invalidProfileList") };
    }
    return { ok: true, profiles: body.profiles as ProfileSummary[] };
  } catch {
    return { ok: false, code: "error", message: t("api.invalidProfileResponse") };
  }
}

/** Fetch a single profile's edit detail (masked key + settings). */
export async function getProfile(profileId: string): Promise<ProfileResult> {
  let response: Response;
  try {
    response = await authFetch(`/api/config/profiles/${encodeURIComponent(profileId)}`);
  } catch {
    return { ok: false, code: "error", message: t("api.unreachableTo") };
  }

  if (response.status === 401) {
    return { ok: false, code: "unauthorized", message: t("api.sessionExpired") };
  }
  if (response.status === 404) {
    return { ok: false, code: "not_found", message: t("api.profileNotFound") };
  }
  if (!response.ok) {
    return { ok: false, code: "error", message: await text(response) };
  }

  try {
    const body = (await response.json()) as { profile?: unknown };
    const profile = parseProfileDetail(body.profile);
    if (profile === undefined) {
      return { ok: false, code: "error", message: t("api.invalidProfile") };
    }
    return { ok: true, profile };
  } catch {
    return { ok: false, code: "error", message: t("api.invalidProfileResponse") };
  }
}

/** Create a new profile. */
export async function createProfile(body: CreateProfileBody): Promise<SaveProfileResult> {
  return saveProfile("/api/config/profiles", "POST", body);
}

/** Update an existing profile. An empty/omitted `apiKey` preserves the stored key. */
export async function updateProfile(
  profileId: string,
  body: UpdateProfileBody,
): Promise<SaveProfileResult> {
  return saveProfile(`/api/config/profiles/${encodeURIComponent(profileId)}`, "PUT", body);
}

/** Delete a profile. */
export async function deleteProfile(profileId: string): Promise<DeleteProfileResult> {
  let response: Response;
  try {
    response = await authFetch(`/api/config/profiles/${encodeURIComponent(profileId)}`, {
      method: "DELETE",
    });
  } catch {
    return "error";
  }

  if (response.ok) return "deleted";
  if (response.status === 401) return "unauthorized";
  if (response.status === 404) return "not_found";
  return "error";
}

async function saveProfile(
  url: string,
  method: "POST" | "PUT",
  body: CreateProfileBody,
): Promise<SaveProfileResult> {
  let response: Response;
  try {
    response = await authFetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, code: "error", message: t("api.unreachableTo") };
  }

  if (response.status === 401) {
    return { ok: false, code: "unauthorized", message: t("api.sessionExpired") };
  }
  if (!response.ok) {
    return { ok: false, code: "error", message: await text(response) };
  }

  try {
    const parsed = (await response.json()) as { profile?: unknown };
    const profile = parseProfileDetail(parsed.profile);
    if (profile === undefined) {
      return { ok: false, code: "error", message: t("api.invalidProfileResponse") };
    }
    return { ok: true, profile };
  } catch {
    return { ok: false, code: "error", message: t("api.invalidProfileResponse") };
  }
}

/** Read the body as text, never throwing. */
async function text(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return t("api.serverErrorHttp", { status: response.status });
  }
}

/**
 * Read the server's `{ error: { message } }` envelope, falling back to the raw
 * body (and finally a generic message) so a lookup failure is always shown.
 */
async function errorMessage(response: Response): Promise<string> {
  try {
    const parsed = (await response.clone().json()) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message !== "") return message;
  } catch {
    // Fall through to the text body.
  }
  return (await text(response)) || t("api.serverErrorHttp", { status: response.status });
}

/**
 * Defensive parse of the detail the server echoes back on create/update. The
 * shape is `ProfileDetail` per the REST contract; missing pieces degrade to
 * safe defaults so the editor never renders `undefined` into an input.
 */
function parseProfileDetail(value: unknown): ProfileDetail | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  const id =
    typeof r.id === "string" ? r.id : typeof r.profileId === "string" ? r.profileId : undefined;
  if (id === undefined) return undefined;
  const authField = r.authField;
  if (authField !== "ANTHROPIC_AUTH_TOKEN" && authField !== "ANTHROPIC_API_KEY") return undefined;
  return {
    profileId: id,
    id,
    name: typeof r.name === "string" ? r.name : "",
    endpoint: typeof r.endpoint === "string" ? r.endpoint : "",
    authField,
    hasKey: r.hasKey === true,
    ...(typeof r.apiKeyMasked === "string" ? { apiKeyMasked: r.apiKeyMasked } : {}),
    ...(typeof r.modelMapping === "object" && r.modelMapping !== null
      ? { modelMapping: r.modelMapping as ModelMapping }
      : {}),
    ...(typeof r.settings === "object" && r.settings !== null
      ? { settings: r.settings as Record<string, unknown> }
      : {}),
    ...(typeof r.createdAt === "number" || typeof r.createdAt === "string"
      ? { createdAt: r.createdAt }
      : {}),
    ...(typeof r.updatedAt === "number" || typeof r.updatedAt === "string"
      ? { updatedAt: r.updatedAt }
      : {}),
  };
}
