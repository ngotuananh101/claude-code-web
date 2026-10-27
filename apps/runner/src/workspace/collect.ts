/**
 * Workspace file collection for the run-start baseline (§15.2, Ruling 7).
 *
 * Both the baseline capture and the snapshot status answer share one question:
 * "what regular files live under the workspace root, and which were refused?"
 * This module owns the filesystem walk so the safety boundary — credential
 * basenames, symlinks and non-regular files never collected, build artifacts
 * never walked — lives in one place rather than being restated at each caller.
 *
 * Two collection strategies: when `git` is available and the workspace is a
 * repository, `git ls-files` returns the tracked set the same way a baseline
 * should. Otherwise the tree is walked directly. Either way the output is
 * sorted and capped at `maxEntries` so a run can never be choked by an
 * enormous tree.
 */

import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { type GitSpawn, gitSpawn } from "../git/spawn.ts";
import { isRefusedCredentialBasename } from "./paths.ts";
import { MAX_SNAPSHOT_ENTRIES } from "@cc-web/protocol";

/** The directories a walk never descends into. */
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".venv",
  "__pycache__",
  "target",
]);

export type Collected = {
  mode: "git" | "walk";
  paths: string[];
  excluded: Array<{ path: string; reason: "credential" | "symlink" | "non_regular" }>;
  truncated: boolean;
};

/** Collect the regular files under `root`, excluding secrets, links and junk. */
export async function collectWorkspaceFiles(
  root: string,
  options: { spawn: GitSpawn; maxEntries?: number },
): Promise<Collected> {
  const spawn = options.spawn ?? gitSpawn;
  const maxEntries = options.maxEntries ?? MAX_SNAPSHOT_ENTRIES;

  const gitResult = await spawn(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    root,
  );
  if (gitResult.exitCode === 0) {
    return collectFromGit(gitResult.stdout, maxEntries);
  }

  // Fall back to a structural walk. Git mode is best-effort: a non-repo or a
  // missing `git` binary must not prevent a baseline from being captured.
  const collected: string[] = [];
  const excluded: Collected["excluded"] = [];
  await walk(root, "", collected, excluded, maxEntries + 1);
  const truncated = collected.length > maxEntries;
  return {
    mode: "walk",
    paths: collected.sort().slice(0, maxEntries),
    excluded,
    truncated,
  };
}

function collectFromGit(stdout: string, maxEntries: number): Collected {
  const trimmed = stdout.replace(/\u0000+$/, "");
  if (trimmed === "") {
    return { mode: "git", paths: [], excluded: [], truncated: false };
  }
  const paths = trimmed.split("\0").sort();
  return {
    mode: "git",
    paths: paths.slice(0, maxEntries),
    excluded: [],
    truncated: paths.length > maxEntries,
  };
}

/**
 * Recursively walk `root + relative`, skipping ignored dirs and special files.
 *
 * Stops once `limit` entries have been collected — the caller passes one past
 * `maxEntries` so it can tell whether truncation is needed.
 */
async function walk(
  root: string,
  relative: string,
  collected: string[],
  excluded: Collected["excluded"],
  limit: number,
): Promise<void> {
  if (collected.length + excluded.length >= limit) return;

  const dir = join(root, relative || ".");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;

    const entryPath = relative === "" ? entry.name : `${relative}/${entry.name}`;

    const info = await lstat(join(root, entryPath)).catch(() => null);
    if (info === null) continue;

    // Never follow a symlink: it is excluded by the link itself, not its target.
    if (info.isSymbolicLink()) {
      excluded.push({ path: entryPath, reason: "symlink" });
      continue;
    }

    // Directories descend; anything that is neither a symlink nor a directory
    // is a socket, fifo or device and is excluded as non-regular.
    if (info.isDirectory()) {
      await walk(root, entryPath, collected, excluded, limit);
      continue;
    }

    if (!info.isFile()) {
      excluded.push({ path: entryPath, reason: "non_regular" });
      continue;
    }

    // A regular file: check the credential basename before admitting it.
    if (isRefusedCredentialBasename(entry.name)) {
      excluded.push({ path: entryPath, reason: "credential" });
      continue;
    }

    collected.push(entryPath);
    if (collected.length >= limit) return;
  }
}
