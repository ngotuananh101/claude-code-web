/**
 * Workspace id → path resolution for the daemon (§11.1 MVP).
 *
 * The full design binds workspaces through registration; until that surface
 * exists, the operator declares one directory in the environment and every
 * dispatch that names the default workspace lands there. Anything else the
 * resolver does not know stays `undefined`, which the run controller turns
 * into an `unknown_workspace` refusal rather than a guess.
 */

import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { DeclaredWorkspace } from "@cc-web/protocol";
import { listCustomWorkspaces } from "@cc-web/runner-db";

/**
 * The workspaces this runner serves, derived from `CC_WEB_RUNNER_DEFAULT_WORKSPACE`'s
 * value — the same source `defaultWorkspaceResolver` reads, so what the runner
 * advertises in its hello and what its resolver answers can never disagree.
 * A blank value declares nothing.
 */
export function declaredWorkspaces(env: string | undefined): DeclaredWorkspace[] {
  const path = env?.trim();
  if (path === undefined || path === "") return [];
  return [{ workspaceId: "default", path }];
}

/**
 * Build a resolver from `CC_WEB_RUNNER_DEFAULT_WORKSPACE`'s value. A blank
 * value disables the bridge entirely — an empty string is not a path anyone
 * meant to hand out.
 */
export function defaultWorkspaceResolver(
  env: string | undefined,
): (workspaceId: string) => string | undefined {
  const path = env?.trim();
  if (path === undefined || path === "") return () => undefined;
  return (workspaceId) => (workspaceId === "default" ? path : undefined);
}

/**
 * Options for `discoverWorkspaces`. All seams are injectable so tests pin
 * discovery without touching the real `~/.claude` tree.
 */
export type DiscoverOptions = {
  /** `CC_WEB_RUNNER_DEFAULT_WORKSPACE`; the "default" workspace. */
  defaultEnv?: string;
  /** Runner-local DB holding persisted custom workspaces. Optional. */
  db?: Database;
  /** The host home directory; defaults to `os.homedir()` when omitted. */
  homeDir?: string;
};

/**
 * Merge the three sources of workspaces the runner serves on this host (§18.2):
 *
 *  1. `defaultEnv` (`CC_WEB_RUNNER_DEFAULT_WORKSPACE`) → `workspaceId: "default"`.
 *  2. Custom workspaces persisted in `db` via the directory browser.
 *  3. Projects under `<homeDir>/.claude/projects/`, decoded from Claude Code's
 *     encoded directory names or read from a session file's `cwd`, filtered to
 *     directories that actually exist on disk.
 *
 * Each returned workspace has a deterministic, URL-friendly `workspaceId`:
 * the default env keeps `"default"`; every other path is slugged to its
 * trailing segment and disambiguated with a short hash when slugs collide.
 * Workspaces are deduplicated by canonical path (`path.resolve`).
 */
export function discoverWorkspaces(options: DiscoverOptions): DeclaredWorkspace[] {
  const { defaultEnv, db, homeDir } = options;
  const home = homeDir ?? process.env["HOME"] ?? "";

  const collected: DeclaredWorkspace[] = [];

  // 1. default env → "default" (canonicalized).
  const trimmed = defaultEnv?.trim();
  if (trimmed && trimmed !== "") {
    collected.push({ workspaceId: "default", path: resolve(trimmed) });
  }

  // 2. custom workspaces from the db keep their persisted ids (canonicalized).
  if (db) {
    const custom = listCustomWorkspaces(db);
    for (const w of custom) {
      collected.push({ workspaceId: w.workspaceId, path: resolve(w.path) });
    }
  }

  // 3. discovered projects under ~/.claude/projects (no id yet; slugged later).
  const discovered = scanClaudeProjects(home);
  for (const w of discovered) {
    collected.push(w);
  }

  // Canonicalize, prefer "default", slug the rest, dedupe by path.
  return assignWorkspaceIds(collected);
}

/**
 * Scan `<home>/.claude/projects/` for Claude Code project entries. Each entry
 * is an encoded directory name (slashes → `-`) possibly containing `*.jsonl`
 * session files whose `cwd` names the real project. Returns canonical,
 * on-disk-existing paths only.
 */
function scanClaudeProjects(home: string): DeclaredWorkspace[] {
  if (!home) return [];
  const projectsDir = `${home}/.claude/projects`;
  const entries = tryReaddir(projectsDir);
  if (entries === undefined) return [];

  const seen = new Set<string>();
  const out: DeclaredWorkspace[] = [];

  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const encoded = `${projectsDir}/${name}`;
    // Decode the encoded name: Claude prefixes with "-" and replaces "/" with "-".
    const decoded = name.startsWith("-") ? name.slice(1).replace(/-/g, "/") : name;
    addIfReal(resolve(decoded), seen, out);

    // A session file inside the encoded dir may carry the canonical cwd.
    const sessionEntries = tryReaddir(encoded);
    if (sessionEntries !== undefined) {
      for (const sname of sessionEntries) {
        if (!sname.endsWith(".jsonl")) continue;
        const cwds = extractCwds(`${encoded}/${sname}`);
        for (const cwd of cwds) {
          addIfReal(resolve(cwd), seen, out);
        }
      }
    }
  }

  return out;
}

/** Resolve `cwd` fields from a Claude session jsonl (best-effort). */
function extractCwds(file: string): string[] {
  const content = tryReadFile(file);
  if (content === undefined) return [];
  const out: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const obj = JSON.parse(trimmed);
      const cwd = obj?.cwd;
      if (typeof cwd === "string") out.push(cwd);
    } catch {
      /* ignore non-json lines */
    }
  }
  return out;
}

/** Add a real directory to the discovered set, guarding against duplicates. */
function addIfReal(path: string, seen: Set<string>, out: DeclaredWorkspace[]): void {
  const canonical = resolve(path);
  if (seen.has(canonical)) return;
  if (!isRealDir(canonical)) return; // not a directory or missing
  seen.add(canonical);
  out.push({ workspaceId: "", path: canonical });
}

/**
 * Assign deterministic, URL-friendly `workspaceId`s and dedupe by canonical path.
 *
 * - Entries that already carry an id (`"default"` from the env, or a persisted
 *   custom id from the DB) keep it; if two sources collide on a path, `"default"`
 *   wins and otherwise the first-seen entry is kept.
 * - Discovered projects carry no id; they are slugged to their trailing path
 *   segment and disambiguated with a short hash when slugs collide.
 */
function assignWorkspaceIds(ws: DeclaredWorkspace[]): DeclaredWorkspace[] {
  const byPath = new Map<string, DeclaredWorkspace>();
  for (const w of ws) {
    const canonical = resolve(w.path);
    const existing = byPath.get(canonical);
    if (existing === undefined) {
      byPath.set(canonical, { ...w });
      continue;
    }
    // "default" id wins ties; otherwise keep the first.
    if (w.workspaceId === "default") {
      byPath.set(canonical, { ...w });
    }
  }

  const base = Array.from(byPath.values());
  const slugCounts = new Map<string, number>();
  const result: DeclaredWorkspace[] = [];

  for (const w of base) {
    // Entries with an id (default/custom) are kept as-is.
    if (w.workspaceId !== "") {
      result.push(w);
      continue;
    }
    let id = slugFor(w.path);
    const count = (slugCounts.get(id) ?? 0) + 1;
    slugCounts.set(id, count);
    if (count > 1) {
      id = `${id}-${shortHash(w.path)}`;
    }
    result.push({ workspaceId: id, path: w.path });
  }

  return result;
}

/** Turn a path into a URL-friendly slug (lowercase, dashes, no slashes). */
function slugFor(path: string): string {
  const seg = path.split("/").filter(Boolean).pop() ?? path;
  const slug = seg
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "workspace" : slug;
}

/** Short non-cryptographic hash of a string for disambiguating slugs. */
function shortHash(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16).slice(0, 6).padStart(6, "0");
}

/**
 * Build a resolver from a declared workspace list: `workspaceId` → `path`.
 * Unknown ids resolve to `undefined` so the run controller can refuse honestly
 * rather than inventing a path. When the same id appears more than once the
 * last wins (deterministic for a given input ordering).
 */
export function workspaceResolverFrom(
  workspaces: DeclaredWorkspace[],
): (workspaceId: string) => string | undefined {
  const index = new Map<string, string>();
  for (const w of workspaces) {
    index.set(w.workspaceId, w.path);
  }
  return (workspaceId) => index.get(workspaceId);
}

/* ---- filesystem seams ---- */

function tryReaddir(dir: string): string[] | undefined {
  try {
    return readdirSync(dir);
  } catch {
    return undefined;
  }
}

function tryReadFile(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function isRealDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
