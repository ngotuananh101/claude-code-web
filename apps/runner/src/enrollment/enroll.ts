/**
 * `runner enroll` (§6.1).
 *
 * The token is the only credential in this exchange, so where it travels
 * matters as much as whether it works:
 *
 *  - it goes in the request **body**, never a query string, so it does not land
 *    in access logs on either side
 *  - the CLI reads it from stdin or the environment, never argv, so it does not
 *    land in shell history or `ps`
 *
 * Nothing is written to disk unless the server accepted. A partial identity
 * would make the next `runner run` report "missing identity" instead of the
 * actual reason enrollment failed.
 */

import type { RunnerIdentity } from "../identity/identity-store.ts";

export type EnrollOptions = {
  controlUrl: string;
  token: string;
  identityDir: string;
  /** Injected so the flow is testable without a network or a filesystem. */
  fetch: typeof fetch;
  saveIdentity: (identity: RunnerIdentity) => Promise<void>;
};

export type EnrollResult = { ok: true; identity: RunnerIdentity } | { ok: false; message: string };

/** Trailing slashes would produce `//api/runner-enroll`. */
function endpoint(controlUrl: string): string {
  return `${controlUrl.replace(/\/+$/, "")}/api/runner-enroll`;
}

export async function enroll(options: EnrollOptions): Promise<EnrollResult> {
  let response: Response;
  try {
    response = await options.fetch(endpoint(options.controlUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: options.token }),
    });
  } catch (error) {
    // A refused connection is an operator problem (wrong URL, server down), and
    // reporting it as one beats an unhandled rejection.
    return { ok: false, message: `enrollment failed: ${(error as Error).message}` };
  }

  if (!response.ok) {
    // The server deliberately does not distinguish unknown/consumed/expired.
    // Repeating the status is all we can say, and all we should.
    return { ok: false, message: `enrollment refused (HTTP ${response.status})` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, message: "enrollment failed: response was not JSON" };
  }

  const record = body as Record<string, unknown>;
  const runnerId = record["runnerId"];
  const credential = record["credential"];
  if (typeof runnerId !== "string" || runnerId === "" || typeof credential !== "string") {
    // Saving this would produce an identity that cannot connect, and the error
    // would surface much later, as an auth failure.
    return { ok: false, message: "enrollment failed: response missing runnerId or credential" };
  }

  const identity: RunnerIdentity = {
    runnerId,
    controlUrl: options.controlUrl,
    credential,
  };

  try {
    await options.saveIdentity(identity);
  } catch (error) {
    return {
      ok: false,
      message: `enrollment failed: cannot save identity: ${(error as Error).message}`,
    };
  }

  return { ok: true, identity };
}
