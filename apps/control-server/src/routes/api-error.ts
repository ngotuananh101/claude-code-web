/**
 * §17.3's API error shape and its HTTP status mapping (§10 §7.1).
 *
 * Moved out of `inspect-routes.ts` so both the read surface and the mutation
 * surface share one definition: an operator (and the web service T11) parses a
 * single shape for every domain failure.
 */

/**
 * The only code in this surface that a retry can repair: the runner was not
 * ready, or did not answer in time. Every other refusal is a fact about the
 * path, the workspace or the request — retrying it changes nothing, whatever
 * status class it carries. Deriving the flag from the status told an operator
 * to retry a 502 `NOT_A_FILE` forever.
 */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set(["RUNNER_UNAVAILABLE"]);

/**
 * §17.3's `ApiError`, exactly: the code lives under `error` so the web service
 * (T11) parses one shape for every domain failure, and `requestId` is what an
 * operator quotes in a bug report. `retryable` follows the code (see above).
 */
export function jsonError(code: string, message: string, status: number): Response {
  return new Response(
    JSON.stringify({
      error: { code, message, retryable: RETRYABLE_CODES.has(code), details: undefined },
      requestId: crypto.randomUUID(),
    }),
    {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    },
  );
}

/**
 * Map a runner refusal code to its HTTP status (§10 §7.1).
 *
 * Anything not enumerated is a 502 — a failure the server cannot attribute to a
 * client shape it understands. New codes from an unknown runner fall through to
 * 502 rather than being guessed as 4xx.
 */
export function statusForCode(code: string): number {
  switch (code) {
    case "PATH_OUTSIDE_WORKSPACE":
      return 400;
    case "CREDENTIAL_FILE_REFUSED":
      return 403;
    case "FILE_NOT_FOUND":
    case "WORKSPACE_NOT_FOUND":
    case "NO_SNAPSHOT":
      return 404;
    case "FILE_CONFLICT":
    case "WORKSPACE_BUSY":
    case "REVERT_STALE":
    case "SNAPSHOT_PARTIAL":
    case "PLAN_TOO_LARGE":
    case "SNAPSHOT_INCOMPARABLE":
      return 409;
    case "SYMLINK_REFUSED":
    case "FILE_UNSUPPORTED":
      return 400;
    case "FILE_UNWRITABLE":
      return 502;
    default:
      return 502;
  }
}
