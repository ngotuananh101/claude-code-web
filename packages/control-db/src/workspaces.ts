import type { Database } from "bun:sqlite";

/**
 * The control plane's record of what each runner serves (§15.1).
 *
 * The runner is the registration authority: every successful hello and
 * reconcile carries the full declaration, and this module replaces the
 * runner's rows with it. Nothing here accumulates history — a workspace the
 * current boot does not declare has no row, which is what keeps placement
 * from routing work to a directory the runner no longer vouches for.
 */

export type DeclaredWorkspaceRow = {
  workspaceId: string;
  path: string;
};

export type OwnerWorkspace = {
  workspaceId: string;
  runnerId: string;
  path: string;
  createdAt: number;
};

/**
 * Replace a runner's declared workspaces. One transaction: a crash between the
 * delete and the insert must not leave the runner with no rows when it just
 * declared some (an empty declaration after a non-empty one is a real state,
 * but a crash-shaped hole is not).
 */
export function upsertRunnerWorkspaces(
  db: Database,
  runnerId: string,
  workspaces: readonly DeclaredWorkspaceRow[],
): void {
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM workspaces WHERE runner_id = ?").run(runnerId);
    const insert = db.prepare(
      `INSERT INTO workspaces (runner_id, workspace_id, path, registered_at)
       VALUES (?, ?, ?, ?)`,
    );
    const now = Date.now();
    for (const workspace of workspaces) {
      insert.run(runnerId, workspace.workspaceId, workspace.path, now);
    }
  });
  replace();
}

/**
 * The owner's workspaces across every runner they still hold, oldest runner
 * first — the stable order GET /api/workspaces and placement both read.
 */
export function workspacesForOwner(db: Database, ownerId: string): OwnerWorkspace[] {
  const rows = db
    .prepare(
      `SELECT w.workspace_id, w.runner_id, w.path, r.created_at
       FROM workspaces w
       JOIN runners r ON r.id = w.runner_id
       WHERE r.owner_id = ? AND r.revoked_at IS NULL
       ORDER BY r.created_at ASC, w.workspace_id ASC`,
    )
    .all(ownerId) as Array<{
    workspace_id: string;
    runner_id: string;
    path: string;
    created_at: number;
  }>;
  return rows.map((row) => ({
    workspaceId: row.workspace_id,
    runnerId: row.runner_id,
    path: row.path,
    createdAt: row.created_at,
  }));
}
