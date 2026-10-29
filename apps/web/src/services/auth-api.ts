/**
 * First-time setup HTTP surface (§19.1, Task 3).
 *
 * Two calls against the control server's owner-bootstrap routes:
 * - `fetchSetupStatus()` reads whether the owner account still needs seeding, so
 *   the front door can show the setup form or defer to login.
 * - `submitSetup({ username, password })` posts the one-shot credentials that
 *   create that account; the server is locked to the moment the users table is
 *   empty, so a 403 means the account already exists.
 *
 * Neither throws: a transport/parse failure becomes a generic Vietnamese
 * outcome so a caller never needs a try/catch. The server returns plain-text
 * refusals (403 "forbidden", 400 "bad request") rather than a JSON error
 * object, so the status code alone drives the message here.
 */

/** Vietnamese copy for the plain-text status codes the server returns. */
const STATUS_MESSAGES: Record<number, string> = {
  400: "Tài khoản hoặc mật khẩu không hợp lệ.",
  403: "Tài khoản đã được tạo rồi.",
};

/** The copy for a transport or parse failure — there is no code to translate. */
const UNREACHABLE = "Không kết nối được máy chủ.";

/**
 * Whether the owner account still needs seeding (§19.1). Answers `setupRequired`
 * directly from the `GET /auth/setup-status` body; a failure (no connectivity,
 * non-JSON, or a refusal) reads as "no, it does not" — the front door keeps
 * showing the login form so the operator can retry rather than hang on setup.
 */
export function fetchSetupStatus(): Promise<{ setupRequired: boolean }> {
  return fetch("/auth/setup-status", { method: "GET" })
    .then((response) => {
      if (!response.ok) return { setupRequired: false };
      return response.json().then(
        (body) =>
          body?.setupRequired === true ? { setupRequired: true } : { setupRequired: false },
        () => ({ setupRequired: false }),
      );
    })
    .catch(() => ({ setupRequired: false }));
}

/**
 * Create the single owner account (§19.1): posts `{ username, password }` to
 * `POST /auth/setup`. A 201 sets the session cookie (HttpOnly, SameSite=Lax)
 * which the browser carries along automatically — the caller needs no token
 * handling. A 400/403 carries a Vietnamese reason, as does any transport
 * failure, all without throwing.
 */
export function submitSetup(payload: {
  username: string;
  password: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  return fetch("/auth/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then((response) => {
      if (response.ok) return { ok: true as const };
      const message = STATUS_MESSAGES[response.status] ?? UNREACHABLE;
      return { ok: false as const, message };
    })
    .catch(() => ({ ok: false as const, message: UNREACHABLE }));
}

let refreshPromise: Promise<boolean> | null = null;

/**
 * Attempt to refresh the access token via POST /auth/refresh.
 * Deduplicates in-flight calls so multiple simultaneous 401s only trigger
 * a single token refresh round-trip.
 */
export async function refreshAuthToken(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const response = await fetch("/auth/refresh", { method: "POST" });
      return response.ok;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/**
 * Transparent fetch wrapper that attempts token refresh on 401 and retries once.
 */
export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  const urlStr =
    typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;

  if (response.status === 401 && !urlStr.includes("/auth/refresh")) {
    const refreshed = await refreshAuthToken();
    if (refreshed) {
      return fetch(input, init);
    }
  }

  return response;
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let boundFocusListener: (() => void) | null = null;

/**
 * Periodically refreshes the auth token while the user is active in the app.
 * Also triggers refresh on window focus / visibility change.
 */
export function startTokenRefreshTimer(): void {
  if (refreshTimer !== null) return;

  // Refresh every 5 minutes while active (token expires in 15 minutes)
  refreshTimer = setInterval(
    () => {
      void refreshAuthToken();
    },
    5 * 60 * 1000,
  );

  if (typeof window !== "undefined") {
    boundFocusListener = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void refreshAuthToken();
      }
    };
    window.addEventListener("focus", boundFocusListener);
    document.addEventListener("visibilitychange", boundFocusListener);
  }
}

/**
 * Stops the token refresh timer and removes window event listeners.
 */
export function stopTokenRefreshTimer(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (typeof window !== "undefined" && boundFocusListener !== null) {
    window.removeEventListener("focus", boundFocusListener);
    document.removeEventListener("visibilitychange", boundFocusListener);
    boundFocusListener = null;
  }
}
