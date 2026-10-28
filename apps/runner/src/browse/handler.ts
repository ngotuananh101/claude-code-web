/**
 * Directory browser handler for `workspace.fs.browse` (§18.2 discovery surface).
 *
 * This handler answers a read-only directory listing request from the control
 * server. It mirrors the inspection handler's idiom: the frame is the only channel
 * back, so every failure becomes `{ ok: false, error: { code, message } }` and
 * the handler never throws — a throw would leave the server's waiter to time out
 * with no explanation.
 *
 * Path resolution is deliberate and bounded:
 *  - Empty/omitted path defaults to the runner's configured home.
 *  - A leading `~` is expanded to that home, so the server can address the
 *    user's home without the absolute path ever crossing the wire.
 *  - `path.resolve` normalizes the remainder so a traversal like `../` is
 *    collapsed before any filesystem op runs.
 *
 * There is no workspace lock here: a browse is a read of the host filesystem
 * outside any single workspace, so it touches no attempt machinery (Ruling 6).
 */

import { type Dirent, existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  BROWSE_CAPABILITY,
  type FsBrowseResult,
  MAX_BROWSE_ENTRIES,
  parseBrowseRequest,
  type RpcResultFrame,
} from "@cc-web/protocol";

export type BrowseHandlerOptions = {
  /** The runner's own home directory; falls back to `process.env["HOME"]` then `os.homedir()`. */
  homeDir?: string;
};

/** Advisory: which optional command kind this runner implements. */
export const BROWSE_CAPABILITIES: string[] = [BROWSE_CAPABILITY];

/** The command kind this handler owns. */
const BROWSE_KINDS = new Set(["workspace.fs.browse"]);

export function createBrowseHandler(
  options?: BrowseHandlerOptions,
): (command: unknown) => Promise<RpcResultFrame> {
  const homeDir = options?.homeDir ?? process.env["HOME"] ?? homedir();

  function refuse(commandId: string, code: string, message: string): RpcResultFrame {
    return { type: "rpc.result", commandId, ok: false, error: { code, message } };
  }

  function answer(commandId: string, result: FsBrowseResult): RpcResultFrame {
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
    if (typeof kind !== "string" || !BROWSE_KINDS.has(kind))
      return refuse(commandId, "UNSUPPORTED_COMMAND", "not a browse command");

    const request = parseBrowseRequest(kind, record["payload"]);
    if (request === undefined)
      return refuse(commandId, "UNSUPPORTED_COMMAND", "unrecognised browse payload");

    try {
      return await browse(commandId, request, homeDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return refuse(commandId, "FILE_UNREADABLE", message.slice(0, 500));
    }
  };

  async function browse(
    commandId: string,
    request: { path?: string; showHidden?: boolean },
    home: string,
  ): Promise<RpcResultFrame> {
    // Resolve the target path: empty defaults to home, ~ expands to home.
    let requestedPath = request.path ?? "";
    if (requestedPath === "") requestedPath = home;
    if (requestedPath.startsWith("~/")) requestedPath = join(home, requestedPath.slice(2));
    else if (requestedPath === "~") requestedPath = home;
    const currentPath = resolve(requestedPath);

    // The path must exist and be a directory.
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(currentPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return refuse(commandId, "NOT_FOUND", "path does not exist");
      if (err.code === "EACCES" || err.code === "EPERM")
        return refuse(commandId, "PERMISSION_DENIED", "directory could not be read");
      return refuse(commandId, "FILE_UNREADABLE", "directory could not be read");
    }

    if (!info.isDirectory()) return refuse(commandId, "NOT_A_DIRECTORY", "path is not a directory");

    // Read directory entries.
    let dirents: Dirent[];
    try {
      dirents = await readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return refuse(commandId, "NOT_FOUND", "path does not exist");
      if (err.code === "EACCES" || err.code === "EPERM")
        return refuse(commandId, "PERMISSION_DENIED", "directory could not be read");
      return refuse(commandId, "FILE_UNREADABLE", "directory could not be read");
    }

    // Filter hidden files unless showHidden is explicitly true.
    if (request.showHidden !== true) {
      dirents = dirents.filter((d) => !d.name.startsWith("."));
    }

    // Sort: directories first (alphabetical), then files (alphabetical).
    const dirs = dirents.filter((d) => d.isDirectory());
    const files = dirents.filter((d) => !d.isDirectory());
    dirs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const truncated = dirs.length + files.length > MAX_BROWSE_ENTRIES;
    const kept = [...dirs, ...files].slice(0, MAX_BROWSE_ENTRIES);

    const entries = kept.map((dirent) => {
      const entryPath = join(currentPath, dirent.name);
      const isDir = dirent.isDirectory();
      const isGitRepo = isDir && existsSync(join(entryPath, ".git"));
      const hasClaudeProject = isDir && existsSync(join(entryPath, ".claude"));
      return {
        name: dirent.name,
        path: entryPath,
        isDir,
        isGitRepo,
        hasClaudeProject,
      };
    });

    // Build shortcuts.
    const shortcuts: Array<{ label: string; path: string }> = [
      { label: "~", path: home },
      { label: "/", path: "/" },
    ];
    if (existsSync("/mnt")) {
      shortcuts.push({ label: "/mnt", path: "/mnt" });
    }

    // Parent path: null when already at the filesystem root.
    const parentPath = currentPath !== "/" ? dirname(currentPath) : null;

    return answer(commandId, {
      op: "fs.browse",
      currentPath,
      parentPath,
      shortcuts,
      entries,
      truncated,
    });
  }
}
