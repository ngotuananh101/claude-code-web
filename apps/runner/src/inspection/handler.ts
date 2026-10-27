/**
 * Answering a read-only inspection (§23, rulings 6, 8, 9, 11).
 *
 * Two decisions shape this module, and both are structural rather than
 * stylistic:
 *
 * **No lock, no attempt.** A `RunController` exists to own attempts, workspace
 * locks and SDK lifecycle; an inspection touches none of them (Ruling 6). So
 * this handler has no database, no lock and no `beginAttempt` — it can only
 * answer from the filesystem and `git`, which is what makes "an inspect cannot
 * disturb a run" a property of the code rather than a promise about it. The
 * cost, stated in the design: a file an agent is mid-write can be read torn,
 * which is why the result carries a hash of the bytes actually returned.
 *
 * **Refusals, never throws.** The frame is the only channel back to the server
 * (there is no receipt for an inspection), so every failure becomes
 * `{ ok: false, error: { code, message } }`. A throw would leave the server's
 * waiter to time out with no explanation, and the message is redacted because a
 * `git` error can quote an environment variable (§19.4).
 *
 * The diagnostic report is built by construction: every field is a version, a
 * path, a boolean or an enum, and `providerAuth` is a presence check. There is
 * no field a secret value could be assigned to, which is a stronger guarantee
 * than redacting one out afterward (Ruling 9).
 */

import { createHash } from "node:crypto";
import { type Dirent, existsSync, constants as fsConstants } from "node:fs";
import { access, open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BINARY_SNIFF_BYTES,
  type DiagnosticsReport,
  INSPECT_CAPABILITY,
  type InspectRequest,
  type InspectResult,
  MAX_CHANGE_ENTRIES,
  MAX_DIFF_BYTES,
  MAX_FILE_BYTES,
  MAX_LISTING_ENTRIES,
  parseInspectRequest,
  type RpcResultFrame,
} from "@cc-web/protocol";
import { redactErrorText } from "../execution/redact.ts";
import { type GitSpawn, gitSpawn } from "../git/spawn.ts";
import { parsePorcelainStatus } from "../git/status.ts";
import { resolveInsideWorkspace } from "./paths.ts";

export type InspectHandlerOptions = {
  /** The runner's own registration seam — the same one `run.start` resolves through. */
  workspacePathFor: (workspaceId: string) => string | undefined;
  spawn?: GitSpawn;
  now?: () => number;
  homeDir?: string;
  env?: Record<string, string | undefined>;
};

/** Advisory: which optional command kinds this runner implements (Ruling 13). */
export const INSPECT_CAPABILITIES: string[] = [INSPECT_CAPABILITY];

/** The command kinds this handler owns; anything else is not its to answer. */
const INSPECT_KINDS = new Set(["workspace.inspect", "config.inspect"]);

export function createInspectHandler(
  options: InspectHandlerOptions,
): (command: unknown) => Promise<RpcResultFrame> {
  const spawn = options.spawn ?? gitSpawn;
  const home = options.homeDir ?? homedir();
  const env = options.env ?? process.env;

  async function answer(commandId: string, result: InspectResult): Promise<RpcResultFrame> {
    return { type: "rpc.result", commandId, ok: true, result };
  }

  function refuse(commandId: string, code: string, message: string): RpcResultFrame {
    return { type: "rpc.result", commandId, ok: false, error: { code, message } };
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
    if (typeof kind !== "string" || !INSPECT_KINDS.has(kind)) {
      return refuse(commandId, "UNSUPPORTED_COMMAND", "not an inspection command");
    }

    const request = parseInspectRequest(kind, record["payload"]);
    if (request === undefined) {
      return refuse(commandId, "UNSUPPORTED_COMMAND", "unrecognised inspection payload");
    }

    const workspaceId = record["workspaceId"];
    if (typeof workspaceId !== "string" || workspaceId === "") {
      return refuse(commandId, "WORKSPACE_NOT_FOUND", "command names no workspace");
    }
    const root = options.workspacePathFor(workspaceId);
    if (root === undefined) {
      return refuse(commandId, "WORKSPACE_NOT_FOUND", "workspace is not served by this runner");
    }

    try {
      return await dispatch(commandId, root, request, { spawn, home, env });
    } catch (error) {
      // A throw here is a bug or a dying filesystem, not a result. Answer with a
      // redacted message so the waiter settles instead of timing out blind.
      const message = redactErrorText(error instanceof Error ? error.message : String(error));
      return refuse(commandId, "FILE_UNREADABLE", message.slice(0, 500));
    }
  };

  async function dispatch(
    commandId: string,
    root: string,
    request: InspectRequest,
    deps: { spawn: GitSpawn; home: string; env: Record<string, string | undefined> },
  ): Promise<RpcResultFrame> {
    switch (request.op) {
      case "file.list":
        return listDirectory(commandId, root, request.path);
      case "file.read":
        return readFile(commandId, root, request.path);
      case "git.changes":
        return gitChanges(commandId, root, deps.spawn);
      case "git.diff":
        return gitDiff(commandId, root, request.path, deps.spawn);
      case "diagnostics":
        return diagnostics(commandId, root, deps);
      case "snapshot.status":
        return refuse(commandId, "UNSUPPORTED_COMMAND", "snapshot.status is not implemented in this runner");
    }
  }

  async function listDirectory(
    commandId: string,
    root: string,
    path: string,
  ): Promise<RpcResultFrame> {
    const resolved = await resolveInsideWorkspace(root, path);
    if (!resolved.ok) return refuse(commandId, resolved.code, "path is not inspectable");

    const info = await stat(resolved.absolutePath).catch(() => null);
    if (info === null) return refuse(commandId, "FILE_NOT_FOUND", "path does not exist");
    if (!info.isDirectory()) return refuse(commandId, "NOT_A_DIRECTORY", "path is not a directory");

    let dirents: Dirent[];
    try {
      dirents = await readdir(resolved.absolutePath, { withFileTypes: true });
    } catch {
      return refuse(commandId, "FILE_UNREADABLE", "directory could not be read");
    }

    // Sort before capping so the bound keeps a stable, predictable prefix rather
    // than whichever order the filesystem happened to return.
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const truncated = dirents.length > MAX_LISTING_ENTRIES;
    const kept = dirents.slice(0, MAX_LISTING_ENTRIES);

    const entries = await Promise.all(
      kept.map(async (dirent) => {
        const entryPath = join(resolved.absolutePath, dirent.name);
        const entryInfo = await stat(entryPath).catch(() => null);
        const kind = dirent.isDirectory()
          ? ("directory" as const)
          : dirent.isFile()
            ? ("file" as const)
            : ("other" as const);
        return {
          name: dirent.name,
          kind,
          size: kind === "file" && entryInfo !== null ? entryInfo.size : 0,
        };
      }),
    );

    return answer(commandId, { op: "file.list", path, entries, truncated });
  }

  async function readFile(commandId: string, root: string, path: string): Promise<RpcResultFrame> {
    const resolved = await resolveInsideWorkspace(root, path);
    if (!resolved.ok) return refuse(commandId, resolved.code, "path is not readable");

    const info = await stat(resolved.absolutePath).catch(() => null);
    if (info === null) return refuse(commandId, "FILE_NOT_FOUND", "path does not exist");
    if (!info.isFile()) return refuse(commandId, "NOT_A_FILE", "path is not a regular file");

    // Bounded read: one byte past the cap is enough to know the file was longer
    // than the bound, and never more than the bound is held in memory.
    const handle = await open(resolved.absolutePath, "r");
    let bytes: Buffer;
    try {
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, MAX_FILE_BYTES + 1, 0);
      bytes = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }

    const binary = bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
    if (binary) {
      return answer(commandId, {
        op: "file.read",
        path,
        content: null,
        binary: true,
        truncated: false,
        hash: sha256(bytes.subarray(0, Math.min(bytes.length, MAX_FILE_BYTES))),
        size: info.size,
      });
    }

    const truncated = bytes.length > MAX_FILE_BYTES;
    const returned = bytes.subarray(0, Math.min(bytes.length, MAX_FILE_BYTES));

    return answer(commandId, {
      op: "file.read",
      path,
      content: returned.toString("utf8"),
      binary: false,
      truncated,
      // The hash is of the bytes *actually returned*, so a caller can tell a
      // full read from a prefix and a torn read from a stable one (Ruling 8).
      hash: sha256(returned),
      size: info.size,
    });
  }

  async function gitChanges(
    commandId: string,
    root: string,
    spawner: GitSpawn,
  ): Promise<RpcResultFrame> {
    const result = await spawner(["git", "status", "--porcelain=v1", "-z"], root).catch(
      (error: unknown) => {
        throw new Error(redactErrorText(error instanceof Error ? error.message : String(error)));
      },
    );
    if (result.exitCode !== 0) {
      return refuse(commandId, "FILE_UNREADABLE", "git status failed in this workspace");
    }

    const { entries, truncated } = parsePorcelainStatus(result.stdout, MAX_CHANGE_ENTRIES);
    return answer(commandId, { op: "git.changes", entries, truncated });
  }

  async function gitDiff(
    commandId: string,
    root: string,
    path: string,
    spawner: GitSpawn,
  ): Promise<RpcResultFrame> {
    // A diff legitimately names a deleted file, so the leaf need not exist; the
    // containment rules are unchanged (paths.ts `allowMissing`).
    const resolved = await resolveInsideWorkspace(root, path, {}, { allowMissing: true });
    if (!resolved.ok) return refuse(commandId, resolved.code, "path is not inspectable");

    const result = await spawner(["git", "diff", "--", path], root).catch((error: unknown) => {
      throw new Error(redactErrorText(error instanceof Error ? error.message : String(error)));
    });
    if (result.exitCode !== 0) {
      return refuse(commandId, "FILE_UNREADABLE", "git diff failed in this workspace");
    }

    const diff = truncateToBytes(result.stdout, MAX_DIFF_BYTES);
    return answer(commandId, {
      op: "git.diff",
      path,
      diff: diff.text,
      truncated: diff.truncated,
    });
  }

  async function diagnostics(
    commandId: string,
    root: string,
    deps: { spawn: GitSpawn; home: string; env: Record<string, string | undefined> },
  ): Promise<RpcResultFrame> {
    const gitProbe = await deps.spawn(["git", "--version"], root).catch(() => null);

    const report: DiagnosticsReport = {
      protocolVersion: 1,
      runtime: runtimeVersion(),
      workspaceRoot: root,
      sources: [
        await describeSource("user", join(deps.home, ".claude", "settings.json")),
        await describeSource("project", join(root, ".claude", "settings.json")),
        await describeSource("local", join(root, ".claude", "settings.local.json")),
      ],
      gitAvailable: gitProbe !== null && gitProbe.exitCode === 0,
      providerAuth: providerAuthPresence(deps.env, join(deps.home, ".claude", ".credentials.json")),
      warnings: [],
    };

    return answer(commandId, { op: "diagnostics", report });
  }
}

/**
 * A version string with no path in it. A path is a weak secret, but a
 * server-side operator does not need `$HOME` to read a diagnostic, and omitting
 * it is free (Ruling 9).
 */
function runtimeVersion(): string {
  const versions = process.versions as Record<string, string | undefined>;
  const bun = versions["bun"];
  if (bun !== undefined) return `bun ${bun}`;
  const node = versions["node"];
  return node !== undefined ? `node ${node}` : "unknown";
}

/** Existence and readability only — never the file's content (§7.2, Ruling 9). */
async function describeSource(
  source: "user" | "project" | "local",
  path: string,
): Promise<DiagnosticsReport["sources"][number]> {
  const exists = await stat(path).then(
    (info) => info.isFile(),
    () => false,
  );
  if (!exists) return { source, path, exists: false, readable: false };
  const readable = await access(path, fsConstants.R_OK).then(
    () => true,
    () => false,
  );
  return { source, path, exists: true, readable };
}

/**
 * Whether credential material this run would use is present. Presence only: it
 * answers "is something configured", never the value, and never claims the
 * credential is valid (§8.3, Ruling 9).
 */
function providerAuthPresence(
  env: Record<string, string | undefined>,
  credentialsPath: string,
): DiagnosticsReport["providerAuth"] {
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    if ((env[key]?.length ?? 0) > 0) return "configured";
  }
  // The SDK's own credential file is a presence check on `exists`, never a read
  // — a path whose *content* is the secret must not be opened to answer this.
  return existsSync(credentialsPath) ? "configured" : "missing";
}

/** Truncate a string to a UTF-8 byte budget without splitting a character. */
function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  const buffer = Buffer.from(text, "utf8").subarray(0, maxBytes);
  // `toString` on a sliced buffer may end mid-character; a replacement char at
  // the boundary is preferable to a broken tail, and the flag says it happened.
  return { text: buffer.toString("utf8"), truncated: true };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
