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
 * Fetch the authenticated owner's profiles. The cleartext API key never
 * crosses this boundary — the server returns a presence flag (`hasKey`) plus a
 * masked representation on the detail.
 */
export async function listProfiles(): Promise<ListProfilesResult> {
  let response: Response;
  try {
    response = await authFetch("/api/config/profiles");
  } catch {
    return { ok: false, code: "error", message: "Không kết nối được tới server." };
  }

  if (response.status === 401) {
    return { ok: false, code: "unauthorized", message: "Phiên đăng nhập đã hết hạn." };
  }
  if (!response.ok) {
    return { ok: false, code: "error", message: await text(response) };
  }

  try {
    const body = (await response.json()) as { profiles?: unknown };
    if (!Array.isArray(body.profiles)) {
      return { ok: false, code: "error", message: "Danh sách profile không hợp lệ." };
    }
    return { ok: true, profiles: body.profiles as ProfileSummary[] };
  } catch {
    return { ok: false, code: "error", message: "Phản hồi profile không hợp lệ." };
  }
}

/** Fetch a single profile's edit detail (masked key + settings). */
export async function getProfile(profileId: string): Promise<ProfileResult> {
  let response: Response;
  try {
    response = await authFetch(`/api/config/profiles/${encodeURIComponent(profileId)}`);
  } catch {
    return { ok: false, code: "error", message: "Không kết nối được tới server." };
  }

  if (response.status === 401) {
    return { ok: false, code: "unauthorized", message: "Phiên đăng nhập đã hết hạn." };
  }
  if (response.status === 404) {
    return { ok: false, code: "not_found", message: "Profile không tồn tại." };
  }
  if (!response.ok) {
    return { ok: false, code: "error", message: await text(response) };
  }

  try {
    const body = (await response.json()) as { profile?: unknown };
    const profile = parseProfileDetail(body.profile);
    if (profile === undefined) {
      return { ok: false, code: "error", message: "Profile không hợp lệ." };
    }
    return { ok: true, profile };
  } catch {
    return { ok: false, code: "error", message: "Phản hồi profile không hợp lệ." };
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
    return { ok: false, code: "error", message: "Không kết nối được tới server." };
  }

  if (response.status === 401) {
    return { ok: false, code: "unauthorized", message: "Phiên đăng nhập đã hết hạn." };
  }
  if (!response.ok) {
    return { ok: false, code: "error", message: await text(response) };
  }

  try {
    const parsed = (await response.json()) as { profile?: unknown };
    const profile = parseProfileDetail(parsed.profile);
    if (profile === undefined) {
      return { ok: false, code: "error", message: "Phản hồi profile không hợp lệ." };
    }
    return { ok: true, profile };
  } catch {
    return { ok: false, code: "error", message: "Phản hồi profile không hợp lệ." };
  }
}

/** Read the body as text, never throwing. */
async function text(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return `Lỗi máy chủ (HTTP ${response.status}).`;
  }
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
