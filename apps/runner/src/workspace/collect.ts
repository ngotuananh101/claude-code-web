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

import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { MAX_SNAPSHOT_ENTRIES } from "@cc-web/protocol";
import { type GitSpawn, gitSpawn } from "../git/spawn.ts";
import { isRefusedCredentialBasename } from "./paths.ts";

/** Basenames matching this pattern are atomic-write leftovers; skip them silently. */
const ATOMIC_WRITE_TMP = /^\.cc-web-.*\.tmp$/;

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
  const stoppedAtLimit = await walk(root, "", collected, excluded, maxEntries + 1);
  // A cap-stop for any reason — collected or excluded entries hitting the limit
  // — must surface as truncation. Otherwise a tree full of excluded entries
  // (symlinks / credential names) could halt the walk before real files are
  // visited, yet report `truncated: false`; a later bulk revert would then
  // treat those unseen files as run-created and delete them (§15.2, Ruling 7).
  const truncated = stoppedAtLimit || collected.length > maxEntries;
  return {
    mode: "walk",
    paths: collected.sort().slice(0, maxEntries),
    excluded,
    truncated,
  };
}

function isAtomicWriteTmp(path: string): boolean {
  const name = path.split("/").pop();
  return name !== undefined && ATOMIC_WRITE_TMP.test(name);
}

function collectFromGit(stdout: string, maxEntries: number): Collected {
  let trimmed = stdout;
  while (trimmed.endsWith("\0")) trimmed = trimmed.slice(0, -1);
  if (trimmed === "") {
    return { mode: "git", paths: [], excluded: [], truncated: false };
  }
  const paths = trimmed
    .split("\0")
    .filter((p) => !isAtomicWriteTmp(p))
    .sort();
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
): Promise<boolean> {
  if (collected.length + excluded.length >= limit) return true;

  const dir = join(root, relative || ".");
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  let stoppedAtLimit = false;
  for (const entry of entries) {
    if (stoppedAtLimit) return true;
    if (IGNORED_DIRS.has(entry.name)) continue;

    const entryPath = relative === "" ? entry.name : `${relative}/${entry.name}`;

    const info = await lstat(join(root, entryPath)).catch(() => null);
    if (info === null) continue;

    // Never follow a symlink: it is excluded by the link itself, not its target.
    if (info.isSymbolicLink()) {
      excluded.push({ path: entryPath, reason: "symlink" });
      if (collected.length + excluded.length >= limit) stoppedAtLimit = true;
      continue;
    }

    // Directories descend; anything that is neither a symlink nor a directory
    // is a socket, fifo or device and is excluded as non-regular.
    if (info.isDirectory()) {
      const childStopped = await walk(root, entryPath, collected, excluded, limit);
      if (childStopped) stoppedAtLimit = true;
      continue;
    }

    if (!info.isFile()) {
      excluded.push({ path: entryPath, reason: "non_regular" });
      if (collected.length + excluded.length >= limit) stoppedAtLimit = true;
      continue;
    }

    // A regular file: skip atomic-write temp files silently. They must never
    // enter a manifest (they would churn the plan digest and a later revert
    // would try to rewrite junk).
    if (ATOMIC_WRITE_TMP.test(entry.name)) continue;

    // A regular file: check the credential basename before admitting it.
    if (isRefusedCredentialBasename(entry.name)) {
      excluded.push({ path: entryPath, reason: "credential" });
      if (collected.length + excluded.length >= limit) stoppedAtLimit = true;
      continue;
    }

    collected.push(entryPath);
    if (collected.length >= limit) stoppedAtLimit = true;
  }
  return stoppedAtLimit;
}
