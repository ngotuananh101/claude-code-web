import type { ClaudeCliResolution } from "../execution/claude-cli.ts";
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

/**
 * The inverse of `controlUrlFromServer`: the http(s) origin an identity's
 * `controlUrl` points at.
 *
 * The socket URL is `ws(s)://host/ws/runner`, which cannot be used as a base
 * for an HTTP call — attachment downloads (§4.4) fetch
 * `${origin}/api/runner/attachments/<id>`. Undefined when the stored URL is
 * not a ws(s) URL at all, so the caller can skip the download instead of
 * fetching a nonsense address.
 */
export function serverOriginFromControlUrl(controlUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(controlUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return undefined;

  return `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
}

/**
 * setup's --server resolution: an explicit flag wins, then the origin baked
 * in at compile time (--define CC_WEB_DEFAULT_SERVER — the release workflow's
 * server-url input), then nothing. An empty answer makes setup refuse rather
 * than guess what was meant.
 */
export function resolveServerUrl(
  cliServer: string | undefined,
  compileDefault: string | undefined,
): string {
  const fromCli = cliServer?.trim();
  if (fromCli) return fromCli;
  const fromBuild = compileDefault?.trim();
  if (fromBuild) return fromBuild;
  return "";
}

export type SetupInput = {
  serverUrl: string;
  runnerId: string;
  token: string | undefined;
  identityDir: string;
  /** `--skip-cli-check`: write the identity even when the host CLI is unusable. */
  skipCliCheck?: boolean;
};

export type SetupDeps = {
  /** The real 0600 atomic write; injected so tests never touch the disk. */
  saveIdentity: (dir: string, identity: RunnerIdentity) => Promise<void> | void;
  /**
   * Resolves this runner's Claude Code CLI. Absent means "do not check": a
   * bundled build needs no host CLI, and callers outside the connector keep
   * working unchanged.
   */
  resolveCli?: () => ClaudeCliResolution;
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

  if (deps.resolveCli !== undefined && input.skipCliCheck !== true) {
    const cli = deps.resolveCli();
    if (!cli.ok) return { ok: false, message: cli.guidance };
  }

  await deps.saveIdentity(input.identityDir, {
    runnerId: input.runnerId,
    controlUrl,
    credential: token,
  });

  return { ok: true, controlUrl };
}
