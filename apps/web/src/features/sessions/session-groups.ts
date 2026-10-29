/**
 * How the rail shapes its session list (§16.1).
 *
 * Two questions, answered separately and both persisted: what a group *is*
 * (the folder a session runs in, or the runner that serves it), and how rows
 * are ordered. Grouping is a view over the session store, computed on demand —
 * it never changes what the store holds, and it never lists a session without
 * a folder to place it in.
 */

import type { OwnerWorkspace } from "@/services/workspaces-api.ts";
import type { SessionSummary } from "@/stores/sessions.ts";
import { compositeIdFor, folderBasename, shortRunnerId } from "./folder-tree.ts";

/** What the rail groups sessions by. */
export type SessionGrouping = "project" | "runner";

/** How sessions — and the groups holding them — are ordered. */
export type SessionSort = "recent" | "oldest" | "name";

/** One row of the rail's list. */
export type GroupedSession = {
  session: SessionSummary;
  /** The session's folder basename; null when the workspace is not declared. */
  folder: string | null;
};

/** One heading and the sessions under it. */
export type SessionGroup = {
  key: string;
  /** The heading text: folder basename (project) or short runner id (runner). */
  label: string;
  /** Heading tooltip: the folder path or the full runner id. */
  title: string;
  /** Right-aligned heading detail: short runner id (project) or session count. */
  detail: string;
  sessions: GroupedSession[];
};

/** The sort order the rail cycles through, in the order it cycles. */
export const SESSION_SORTS: readonly SessionSort[] = ["recent", "oldest", "name"];

function compareSessions(sort: SessionSort) {
  return (a: SessionSummary, b: SessionSummary): number => {
    if (sort === "name") return a.sessionId.localeCompare(b.sessionId);
    const delta = b.lastIngestedAt - a.lastIngestedAt;
    return sort === "recent" ? delta : -delta;
  };
}

/**
 * Group the owner's sessions by folder or by runner, sorting rows and groups
 * the same way.
 *
 * A session with no folder pin has no folder to appear under, so it is left
 * out of both shapes: showing it alone — under "Khác" or anywhere else — is
 * the flat list this navigation exists to prevent.
 */
export function groupSessions(
  sessions: readonly SessionSummary[],
  workspaces: readonly OwnerWorkspace[],
  grouping: SessionGrouping,
  sort: SessionSort,
): SessionGroup[] {
  const byComposite = new Map<string, OwnerWorkspace>();
  for (const workspace of workspaces) {
    byComposite.set(compositeIdFor(workspace.runnerId, workspace.workspaceId), workspace);
  }

  const folderOf = (session: SessionSummary): string | null => {
    if (session.runnerId === null || session.workspaceId === null) return null;
    const workspace = byComposite.get(compositeIdFor(session.runnerId, session.workspaceId));
    return workspace === undefined ? null : folderBasename(workspace.path);
  };

  const buckets = new Map<string, GroupedSession[]>();
  for (const session of sessions) {
    if (session.runnerId === null || session.workspaceId === null) continue;
    const key =
      grouping === "project"
        ? compositeIdFor(session.runnerId, session.workspaceId)
        : session.runnerId;
    const rows = buckets.get(key) ?? [];
    rows.push({ session, folder: folderOf(session) });
    buckets.set(key, rows);
  }

  const compare = compareSessions(sort);
  const groups: SessionGroup[] = [];
  for (const [key, rows] of buckets) {
    rows.sort((a, b) => compare(a.session, b.session));
    const runnerId = grouping === "project" ? (key.split("/")[0] ?? key) : key;
    const workspace = grouping === "project" ? byComposite.get(key) : undefined;
    // A folder the control plane no longer declares still needs a heading; the
    // workspace id is the least misleading one available (the path is gone).
    const fallbackLabel = key.slice(key.indexOf("/") + 1);
    groups.push({
      key,
      label: grouping === "project" ? (rows[0]?.folder ?? fallbackLabel) : shortRunnerId(runnerId),
      title:
        grouping === "project" ? (workspace?.path ?? key) : `${runnerId} (${rows.length} phiên)`,
      detail: grouping === "project" ? shortRunnerId(runnerId) : `${rows.length} phiên`,
      sessions: rows,
    });
  }

  groups.sort((a, b) => {
    const first = a.sessions[0];
    const second = b.sessions[0];
    if (first === undefined || second === undefined) return a.label.localeCompare(b.label);
    const byRows = compare(first.session, second.session);
    return byRows !== 0 ? byRows : a.label.localeCompare(b.label);
  });

  return groups;
}

/** The other grouping — one button flips between the two. */
export function nextGrouping(current: SessionGrouping): SessionGrouping {
  return current === "project" ? "runner" : "project";
}

/** The next sort in the cycle: newest → oldest → by id. */
export function nextSort(current: SessionSort): SessionSort {
  const index = SESSION_SORTS.indexOf(current);
  return SESSION_SORTS[(index + 1) % SESSION_SORTS.length] ?? "recent";
}

/** A stored preference, defaulting to project grouping when absent or unknown. */
export function parseGrouping(raw: string | null): SessionGrouping {
  return raw === "runner" ? "runner" : "project";
}

/** A stored preference, defaulting to newest-first when absent or unknown. */
export function parseSort(raw: string | null): SessionSort {
  return SESSION_SORTS.find((sort) => sort === raw) ?? "recent";
}
