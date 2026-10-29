/**
 * Folder-first navigation helpers (§15.1).
 *
 * The console browses sessions the way they exist on a runner's disk: a runner
 * serves folders, and a folder holds the sessions. Nothing here lists sessions
 * without a folder to scope them to — the rule the rail, the palette, the
 * dashboard, and the composer all follow.
 */

import type { OwnerWorkspace } from "@/services/workspaces-api.ts";

/** One folder a runner serves, addressed the way the API addresses it. */
export type FolderItem = {
  compositeId: string;
  runnerId: string;
  workspaceId: string;
  path: string;
};

/** One runner and the folders it declared. */
export type RunnerGroup = {
  runnerId: string;
  /** The first eight characters of the runner uuid — enough to tell runners apart. */
  shortId: string;
  folders: FolderItem[];
};

/** The `(runnerId, workspaceId)` pair as the composite id the API takes. */
export function compositeIdFor(runnerId: string, workspaceId: string): string {
  return `${runnerId}/${workspaceId}`;
}

/** A runner uuid shortened for a chip or a group heading. */
export function shortRunnerId(runnerId: string): string {
  return runnerId.slice(0, 8);
}

/** The trailing segment of a folder path, or the full path if root. */
export function folderBasename(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) return normalized || "/";
  return normalized.slice(lastSlash + 1) || "/";
}

/**
 * Group declared workspaces by the runner that serves them, each runner's
 * folders sorted by path. Runners are ordered by id so the list does not
 * reshuffle as declarations arrive.
 */
export function groupFoldersByRunner(workspaces: readonly OwnerWorkspace[]): RunnerGroup[] {
  const byRunner = new Map<string, FolderItem[]>();
  for (const workspace of workspaces) {
    const folders = byRunner.get(workspace.runnerId) ?? [];
    folders.push({
      compositeId: compositeIdFor(workspace.runnerId, workspace.workspaceId),
      runnerId: workspace.runnerId,
      workspaceId: workspace.workspaceId,
      path: workspace.path,
    });
    byRunner.set(workspace.runnerId, folders);
  }

  return [...byRunner.entries()]
    .map(([runnerId, folders]) => ({
      runnerId,
      shortId: shortRunnerId(runnerId),
      folders: [...folders].sort((a, b) => a.path.localeCompare(b.path)),
    }))
    .sort((a, b) => a.runnerId.localeCompare(b.runnerId));
}

/** The pin and recency a session contributes to its folder's activity. */
export type PinnedSession = {
  runnerId: string | null;
  workspaceId: string | null;
  live: boolean;
  lastIngestedAt: number;
};

/** A folder plus what its sessions did, for the dashboard's short list. */
export type FolderActivity = FolderItem & {
  sessions: number;
  live: number;
  lastActivity: number;
};

/**
 * The folders that hold sessions, most recently active first.
 *
 * Only folders the runner still declares appear: a session pinned to a folder
 * that was removed from the registry has nowhere to open from, and an
 * unpinned (pre-pin) session belongs to no folder at all, so neither is listed.
 */
export function recentFolderActivity(
  sessions: readonly PinnedSession[],
  workspaces: readonly OwnerWorkspace[],
  limit: number,
): FolderActivity[] {
  const folders = new Map<string, FolderItem>();
  for (const workspace of workspaces) {
    const compositeId = compositeIdFor(workspace.runnerId, workspace.workspaceId);
    folders.set(compositeId, {
      compositeId,
      runnerId: workspace.runnerId,
      workspaceId: workspace.workspaceId,
      path: workspace.path,
    });
  }

  const activity = new Map<string, FolderActivity>();
  for (const session of sessions) {
    if (session.runnerId === null || session.workspaceId === null) continue;
    const compositeId = compositeIdFor(session.runnerId, session.workspaceId);
    const folder = folders.get(compositeId);
    if (folder === undefined) continue;
    const row = activity.get(compositeId) ?? {
      ...folder,
      sessions: 0,
      live: 0,
      lastActivity: 0,
    };
    row.sessions += 1;
    if (session.live) row.live += 1;
    row.lastActivity = Math.max(row.lastActivity, session.lastIngestedAt);
    activity.set(compositeId, row);
  }

  return [...activity.values()].sort((a, b) => b.lastActivity - a.lastActivity).slice(0, limit);
}
