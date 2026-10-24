import type { RunnerIdentity } from "../identity/identity-store.ts";

/**
 * Connector setup (§6.1): turn a web-minted token into a local identity.
 *
 * The server URL and runner id are not secrets — argv is fine. The token is,
 * so it travels by env, TTY or stdin and is only ever persisted through
 * `saveIdentity`'s 0600 write. Setup makes no server roundtrip: the token was
 * already minted on the web, and if it is wrong the first `connect` says so.
 */

/**
 * Derives the runner WebSocket endpoint from the operator-pasted server origin.
 * Undefined when the URL is not an http(s) origin — setup refuses rather than
 * guess what was meant.
 */
export function controlUrlFromServer(serverUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

  const ws = url.protocol === "https:" ? "wss:" : "ws:";
  return `${ws}//${url.host}/ws/runner`;
}

export type SetupInput = {
  serverUrl: string;
  runnerId: string;
  token: string | undefined;
  identityDir: string;
};

export type SetupDeps = {
  /** The real 0600 atomic write; injected so tests never touch the disk. */
  saveIdentity: (dir: string, identity: RunnerIdentity) => Promise<void> | void;
};

export type SetupResult = { ok: true; controlUrl: string } | { ok: false; message: string };

export async function runSetup(input: SetupInput, deps: SetupDeps): Promise<SetupResult> {
  const controlUrl = controlUrlFromServer(input.serverUrl);
  if (controlUrl === undefined) {
    return {
      ok: false,
      message: "setup: --server must be an http(s) origin, e.g. http://host:8787",
    };
  }
  if (input.runnerId === "") {
    return { ok: false, message: "setup: --runner-id is required" };
  }

  const token = input.token?.trim();
  if (!token) {
    // Nothing written: a half-configured identity would fail later and
    // more confusingly than an honest refusal now.
    return {
      ok: false,
      message: "setup: no token arrived (env CC_WEB_RUNNER_TOKEN, TTY or stdin)",
    };
  }

  await deps.saveIdentity(input.identityDir, {
    runnerId: input.runnerId,
    controlUrl,
    credential: token,
  });

  return { ok: true, controlUrl };
}
