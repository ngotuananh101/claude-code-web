import type { Database } from "bun:sqlite";

/**
 * Custom workspaces the user chose at runtime by browsing the runner host
 * filesystem (§18.2, Task 2).
 *
 * Unlike `registered_workspaces` (discovered on boot), these are folders a user
 * explicitly selected through the directory browser. They persist across daemon
 * restarts so a hand-picked folder — one that is not under
 * `~/.claude/projects` and not the default workspace — stays available.
 *
 * `path` is UNIQUE so re-adding the same folder is idempotent: a second add with
 * a different id but the same path is a no-op, and the original `workspace_id`
 * and `added_at` are retained.
 */

export type CustomWorkspace = {
  workspaceId: string;
  path: string;
  addedAt: number;
};

/**
 * Record a custom workspace. Idempotent by path: re-adding a folder already
 * known to this runner leaves the existing row (and its `workspace_id`/`added_at`)
 * untouched.
 */
export function addCustomWorkspace(
  db: Database,
  workspace: { workspaceId: string; path: string },
  now?: number,
): void {
  const addedAt = now ?? Date.now();

  db.prepare(
    `INSERT INTO custom_workspaces (workspace_id, path, added_at)
     VALUES (?, ?, ?)
     ON CONFLICT(path) DO NOTHING`,
  ).run(workspace.workspaceId, workspace.path, addedAt);
}

/** All custom workspaces known to this runner, in insertion order. */
export function listCustomWorkspaces(db: Database): CustomWorkspace[] {
  const rows = db
    .prepare(
      `SELECT workspace_id, path, added_at
       FROM custom_workspaces
       ORDER BY added_at ASC, workspace_id ASC`,
    )
    .all() as CustomWorkspaceRow[];

  return rows.map(toCustomWorkspace);
}

/** Row shape returned by SQLite (snake_case). */
type CustomWorkspaceRow = {
  workspace_id: string;
  path: string;
  added_at: number;
};

/** Map a snake_case row into the public camelCase type. */
function toCustomWorkspace(row: CustomWorkspaceRow): CustomWorkspace {
  return { workspaceId: row.workspace_id, path: row.path, addedAt: row.added_at };
}
