/**
 * The runner's live workspace registry (§15.1, §18.2).
 *
 * Discovery walks the disk — one `readdir` per Claude project and one JSONL
 * parse per session file — so the daemon resolves ids against a cached list
 * instead of re-scanning per command. A cache alone is wrong, though: the run
 * controller persists a custom workspace the first time a `run.start` names
 * one it does not know (the §4.1 payload fallback), and every handler that
 * runs afterwards resolves through this registry. Cached at boot, the id
 * stays unresolvable until the process restarts — a session in a freshly
 * browsed folder runs, and then cannot be inspected ("Không tìm thấy
 * workspace.").
 *
 * So a miss is not an answer on its own. It re-reads the custom-workspace
 * rows — a small indexed query — and re-discovers only when they actually
 * changed. The expensive path stays bounded to the moment a workspace
 * appears, and an id that is simply wrong still costs only that query.
 */

import type { Database } from "bun:sqlite";
import type { DeclaredWorkspace } from "@cc-web/protocol";
import { listCustomWorkspaces } from "@cc-web/runner-db";
import { type DiscoverOptions, discoverWorkspaces, workspaceResolverFrom } from "./workspaces.ts";

export type WorkspaceRegistry = {
  /** The workspaces this boot serves, as last discovered. */
  list(): DeclaredWorkspace[];
  /**
   * `workspaceId` → canonical path, or undefined when this runner does not
   * serve it. A miss refreshes the cache once, so a workspace persisted since
   * boot resolves without a restart.
   */
  pathFor(workspaceId: string): string | undefined;
};

/**
 * Build the registry from the same discovery seams `discoverWorkspaces` takes.
 * Discovery runs once eagerly, so the first hello has the list without waiting
 * for a lookup.
 */
export function createWorkspaceRegistry(options: DiscoverOptions): WorkspaceRegistry {
  let discovered = discoverWorkspaces(options);
  let customSignature = signatureOf(options.db);

  function refreshIfCustomChanged(): DeclaredWorkspace[] {
    const signature = signatureOf(options.db);
    if (signature !== customSignature) {
      customSignature = signature;
      discovered = discoverWorkspaces(options);
    }
    return discovered;
  }

  return {
    // A hello or reconcile carries the declaration to the control plane, so it
    // has to name a custom workspace this process has since persisted —
    // otherwise the server never learns the folder exists.
    list: () => refreshIfCustomChanged(),
    pathFor: (workspaceId) => {
      const known = workspaceResolverFrom(discovered)(workspaceId);
      if (known !== undefined) return known;
      return workspaceResolverFrom(refreshIfCustomChanged())(workspaceId);
    },
  };
}

/**
 * A cheap change detector for the persisted custom workspaces. Reading the
 * rows is one query on a table holding a handful of entries; the disk scan it
 * guards against is orders of magnitude more expensive.
 */
function signatureOf(db: Database | undefined): string {
  if (db === undefined) return "";
  return listCustomWorkspaces(db)
    .map((workspace) => `${workspace.workspaceId}\u0000${workspace.path}`)
    .join("\n");
}
