import { sessions } from "../stores/sessions.ts";
import { authFetch } from "./auth-api.ts";

/**
 * User profile update payload (Task 4).
 *
 * All fields are optional. The server validates which combination is valid:
 * - username only: rename the account
 * - avatar only: update the avatar URL
 * - currentPassword + newPassword: change password
 * - Any combination of the above
 */
export interface UpdateMePayload {
  username?: string;
  avatar?: string | null;
  currentPassword?: string;
  newPassword?: string;
}

/**
 * Internal type for building the payload with undefined handling for exactOptionalPropertyTypes
 */
export type UpdateMePayloadInternal = {
  username?: string | undefined;
  avatar?: string | null | undefined;
  currentPassword?: string | undefined;
  newPassword?: string | undefined;
};

/**
 * User profile update response (Task 4).
 *
 * A 200 response becomes `{ ok: true, username, avatar }` with the updated
 * profile, and the sessions store is updated. Any other status parses the
 * error body (or falls back to a generic Vietnamese message).
 */
export type UpdateMeResponse =
  | { ok: true; username: string; avatar: string | null }
  | { ok: false; error: string };

/**
 * Update the signed-in user's profile via PATCH /api/me (Task 4).
 *
 * Sends the payload to the control server. On 200, updates the sessions
 * store's account and avatar, then returns the new profile. On error,
 * returns a Vietnamese message parsed from the body or a generic fallback.
 */
export async function updateUserProfile(
  payload: UpdateMePayloadInternal,
): Promise<UpdateMeResponse> {
  try {
    const response = await authFetch("/api/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      const body = (await response.json()) as { ok: true; username: string; avatar: string | null };
      sessions.account = body.username;
      sessions.avatar = body.avatar ?? null;
      return { ok: true, username: body.username, avatar: body.avatar };
    }

    // Non-200: try to parse the error body, fall back to generic message
    let errorMessage = "Không kết nối được máy chủ.";
    try {
      const errorBody = await response.json();
      if (errorBody && typeof errorBody === "object") {
        // Check for error.message (object form) or error (string form)
        if ("message" in errorBody && typeof errorBody.message === "string") {
          errorMessage = errorBody.message;
        } else if ("error" in errorBody && typeof errorBody.error === "string") {
          errorMessage = errorBody.error;
        } else if (
          "error" in errorBody &&
          typeof errorBody.error === "object" &&
          "message" in errorBody.error
        ) {
          errorMessage = String(errorBody.error.message);
        }
      }
    } catch {
      // Ignore parse errors, keep generic message
    }
    return { ok: false, error: errorMessage };
  } catch {
    return { ok: false, error: "Không kết nối được máy chủ." };
  }
}
