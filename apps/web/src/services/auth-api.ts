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
