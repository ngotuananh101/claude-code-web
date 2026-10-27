/**
 * Path containment for inspection, and later for writes (§15.2, Ruling 7).
 *
 * One entry point, one order of refusals. Every `path` in every inspect op —
 * and, in P3-B, every path a write or revert names — is resolved through here,
 * so the rule lives in a single place instead of being restated, slightly
 * differently, at each call site.
 *
 * The order is load-bearing. A traversal is refused as a traversal even when it
 * also names a credential, because the alternative reads as evidence about what
 * lies outside the workspace: `../id_rsa` answered with `CREDENTIAL_FILE_REFUSED`
 * would tell a caller the file exists and is protected, which is more than it
 * is entitled to know.
 *
 * **The TOCTOU limit, stated rather than papered over.** Resolving symlinks
 * before the containment check closes the ordinary escape (a link out of the
 * tree), but it is not a complete defence: a symlink swapped between the
 * `realpath` here and the caller's `open` can still race, and a path can be
 * replaced with a link after it is checked. That is accepted under §2.1's trust
 * model — the runner's OS user owns the workspace, so an attacker able to swap
 * symlinks inside it already holds the runner's own privileges, and
 * `openat(O_NOFOLLOW)` would be platform-specific complexity for a threat the
 * model does not include. What this module guarantees is that a *static* path —
 * including one that traverses a symlink — cannot name a file outside the root,
 * and that credential files are refused by name.
 */

import { realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

/** Why a path was refused. These are wire codes; the caller sends them as-is. */
export type PathRefusal = "PATH_OUTSIDE_WORKSPACE" | "FILE_NOT_FOUND" | "CREDENTIAL_FILE_REFUSED";

export type ResolvedPath = { ok: true; absolutePath: string } | { ok: false; code: PathRefusal };

/**
 * Basenames whose *content* is never returned, case-insensitively. The file
 * still appears in listings — the operator should learn it is there — but
 * reading it is refused with `CREDENTIAL_FILE_REFUSED`.
 *
 * Patterns are anchored on both ends where a wildcard is meant, so `id_rsa` and
 * `id_rsa.pub` are refused while `id_rsa_backup_note.md` and `keyboard.md` are
 * not: a suffix match on `key` would refuse `keyboard.md`, and a prefix match on
 * `id_` would refuse `id.md`.
 */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa(\.|$)/i,
  /^id_ed25519(\.|$)/i,
  /^\.credentials\.json$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^identity\.json$/i,
  /^\.env(\.|$)/i,
];

/** Whether a file's basename is one whose content is never returned (Ruling 7). */
export function isRefusedCredentialBasename(name: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * The filesystem seams, injectable so the pure refusals can be pinned without a
 * real tree. Production passes nothing and gets `node:fs/promises`.
 */
export type PathDeps = {
  realpath?: (path: string) => Promise<string | null>;
  stat?: (path: string) => Promise<{ isFile(): boolean; isDirectory(): boolean } | null>;
};

/**
 * Resolve `relative` inside `root`, or refuse.
 *
 * An empty `relative` resolves to the root itself: whether a directory is an
 * acceptable answer is the op's business (a listing takes one, a read does not),
 * not the resolver's.
 *
 * `allowMissing` exists for `git.diff`, which legitimately names a path that is
 * no longer on disk — a deleted file is exactly the change an operator wants to
 * see. The containment rules are unchanged: the *parent* is still realpath'd, so
 * a missing leaf cannot be smuggled through a symlinked directory, and the
 * credential check still applies because the path is still named. Only the final
 * existence requirement is lifted, and the returned path is the composed
 * candidate rather than a realpath'd one, since there is nothing to resolve.
 */
export async function resolveInsideWorkspace(
  root: string,
  relative: string,
  deps: PathDeps = {},
  options: { allowMissing?: boolean } = {},
): Promise<ResolvedPath> {
  const realpathOf = deps.realpath ?? defaultRealpath;
  const statOf = deps.stat ?? defaultStat;

  // 1. Shape: absolute paths and any `..` segment are refused before the
  //    filesystem is consulted at all.
  if (isAbsolute(relative)) return refuse("PATH_OUTSIDE_WORKSPACE");
  const segments = relative.split(/[\\/]/);
  if (segments.includes("..")) return refuse("PATH_OUTSIDE_WORKSPACE");

  // 2. Containment on the resolved path, so a symlink out of the tree is caught.
  const realRoot = await realpathOf(root);
  if (realRoot === null) return refuse("FILE_NOT_FOUND");

  const candidate = resolve(join(root, relative));
  const real = await realpathOf(candidate);

  if (real === null) {
    if (options.allowMissing === true) return resolveMissing(realRoot, candidate, relative, deps);
    return refuse("FILE_NOT_FOUND");
  }

  if (!isInside(realRoot, real)) return refuse("PATH_OUTSIDE_WORKSPACE");

  // 3. Credential names are refused by basename, after containment, so the
  //    refusal order stays traversal-first.
  if (isRefusedCredentialBasename(basename(real))) return refuse("CREDENTIAL_FILE_REFUSED");

  // 4. The path must exist. This is also where a dangling symlink surfaces:
  //    realpath already returned null for it above, so reaching here means a
  //    live path; the stat guards against the same race and keeps the contract
  //    "ok implies the path exists".
  const info = await statOf(real);
  if (info === null) return refuse("FILE_NOT_FOUND");

  return { ok: true, absolutePath: real };
}

/**
 * The `allowMissing` path: the leaf is gone, so containment is proven against
 * the nearest existing ancestor instead. That keeps the guarantee that matters
 * — the candidate cannot sit outside the root by way of a symlinked *directory*
 * — while permitting the deleted leaf a diff may legitimately name.
 */
async function resolveMissing(
  realRoot: string,
  candidate: string,
  relative: string,
  deps: PathDeps,
): Promise<ResolvedPath> {
  const realpathOf = deps.realpath ?? defaultRealpath;

  if (isRefusedCredentialBasename(basename(candidate))) return refuse("CREDENTIAL_FILE_REFUSED");

  let ancestor = candidate;
  for (;;) {
    ancestor = resolve(ancestor, "..");
    if (!isInside(realRoot, ancestor) && ancestor !== realRoot) {
      return refuse("PATH_OUTSIDE_WORKSPACE");
    }
    const realAncestor = await realpathOf(ancestor);
    if (realAncestor !== null) {
      if (!isInside(realRoot, realAncestor)) return refuse("PATH_OUTSIDE_WORKSPACE");
      break;
    }
    if (ancestor === realRoot) return refuse("FILE_NOT_FOUND");
  }

  // The relative shape is re-checked so the caller still gets a refusal rather
  // than a path that only looks contained.
  if (relative === "") return refuse("FILE_NOT_FOUND");
  return { ok: true, absolutePath: candidate };
}
/**
 * Whether `candidate` is `root` itself or lies beneath it. Compares against a
 * trailing separator so a sibling sharing the prefix (`/srv/proj2` against
 * `/srv/proj`) is not read as contained.
 */
function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix);
}

function basename(path: string): string {
  const parts = path.split(sep);
  return parts[parts.length - 1] ?? "";
}

async function defaultRealpath(path: string): Promise<string | null> {
  try {
    return await fsRealpath(path);
  } catch {
    return null;
  }
}

async function defaultStat(
  path: string,
): Promise<{ isFile(): boolean; isDirectory(): boolean } | null> {
  try {
    return await fsStat(path);
  } catch {
    return null;
  }
}

function refuse(code: PathRefusal): ResolvedPath {
  return { ok: false, code };
}
