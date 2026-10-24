import { usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/vue";

/**
 * The one auth client (§16.2's singleton rule, applied to auth): baseURL ""
 * keeps every call same-origin, so the session cookie is set and read by the
 * control server the vite dev proxy fronts in development. `displayUsername`
 * mirrors the server plugin's option — the client infers its user shape from
 * it, and a mismatch would type the session wrong.
 */
export const authClient = createAuthClient({
  baseURL: "",
  plugins: [usernameClient({ displayUsername: false })],
});
