/**
 * Session temp-directory cleanup handler (§session-cleanup).
 *
 * Answers the `session.cleanup` command kind by reclaiming a session's
 * `${runnerHome}/tmp/sessions/<sessionId>` directory after the session has
 * finished. The handler mirrors the inspection/browse/mutation idiom: every
 * failure becomes a `RpcResultFrame` with `ok: false`, and the handler never
 * throws — a throw would leave the server's waiter to time out with no
 * explanation.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  parseSessionCleanupRequest,
  type RpcResultFrame,
  type SessionCleanupResult,
} from "@cc-web/protocol";

/**
 * Remove `${runnerHome}/tmp/sessions/<sessionId>` recursively.
 *
 * `sessionId` is sanitized with `path.basename` so a traversal payload like
 * `../evil` lands inside the sessions directory, not above it.
 */
export async function cleanSessionTemp(runnerHome: string, sessionId: string): Promise<void> {
  const safeId = basename(sessionId);
  const target = join(runnerHome, "tmp/sessions", safeId);
  await rm(target, { recursive: true, force: true });
}

/**
 * Scan `${runnerHome}/tmp/sessions/` and remove subdirectories whose mtime
 * is older than `maxAgeMs` (default 7 days). Returns the count of directories
 * removed.
 */
export async function cleanOrphanedTemp(
  runnerHome: string,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000,
): Promise<number> {
  const sessionsDir = join(runnerHome, "tmp/sessions");
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = (await readdir(sessionsDir, { withFileTypes: true })) as Array<{
      name: string;
      isDirectory(): boolean;
    }>;
  } catch {
    // The directory does not exist yet — nothing to clean.
    return 0;
  }

  const cutoff = Date.now() - maxAgeMs;
  let cleaned = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = join(sessionsDir, entry.name);
    let info: { mtimeMs: number };
    try {
      info = await stat(dirPath);
    } catch {
      continue;
    }
    if (info.mtimeMs < cutoff) {
      await rm(dirPath, { recursive: true, force: true });
      cleaned++;
    }
  }

  return cleaned;
}

export type CleanupHandlerOptions = {
  runnerHome: string;
  /**
   * Override for `cleanSessionTemp` so tests can inject a fake without touching
   * the filesystem. Defaults to the real implementation.
   */
  cleanSessionTemp?: (runnerHome: string, sessionId: string) => Promise<void>;
};

/** Advisory: the command kind this handler owns. */
const CLEANUP_KIND = "session.cleanup";

/** The capability a runner advertises before it is sent `session.cleanup`. */
export const CLEANUP_CAPABILITY = "session.cleanup" as const;

/** Advisory: the capability list this handler contributes. */
export const CLEANUP_CAPABILITIES: string[] = [CLEANUP_CAPABILITY];

/**
 * Build a command handler for `session.cleanup` that returns `RpcResultFrame`.
 *
 * Follows the same idiom as the inspect/browse/mutation/sessions handlers:
 * refuses non-matching kinds, parses the payload with the protocol parser,
 * delegates to `cleanSessionTemp`, and never throws.
 */
export function createCleanupHandler(
  options: CleanupHandlerOptions,
): (command: unknown) => Promise<RpcResultFrame> {
  const runnerHome = options.runnerHome;
  const clean = options.cleanSessionTemp ?? cleanSessionTemp;

  function refuse(commandId: string, code: string, message: string): RpcResultFrame {
    return { type: "rpc.result", commandId, ok: false, error: { code, message } };
  }

  function answer(commandId: string, result: SessionCleanupResult): RpcResultFrame {
    return { type: "rpc.result", commandId, ok: true, result };
  }

  return async function handle(command: unknown): Promise<RpcResultFrame> {
    const record =
      typeof command === "object" && command !== null
        ? (command as Record<string, unknown>)
        : undefined;
    const commandId = typeof record?.["commandId"] === "string" ? record["commandId"] : "";

    if (record === undefined)
      return refuse(commandId, "UNSUPPORTED_COMMAND", "command must be an object");

    const kind = record["kind"];
    if (typeof kind !== "string" || kind !== CLEANUP_KIND)
      return refuse(commandId, "UNSUPPORTED_COMMAND", "not a session.cleanup command");

    const request = parseSessionCleanupRequest(record["payload"]);
    if (request === undefined)
      return refuse(commandId, "UNSUPPORTED_COMMAND", "unrecognised session.cleanup payload");

    try {
      await clean(runnerHome, request.sessionId);
      return answer(commandId, { ok: true });
    } catch (error) {
      // Redact: a thrown error can quote a path or environment variable (§19.4).
      const message = error instanceof Error ? error.message : String(error);
      return refuse(commandId, "CLEANUP_FAILED", message.slice(0, 500));
    }
  };
}
