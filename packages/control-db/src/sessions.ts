/**
 * The session pin (§2.3, ADR-006): which (workspace, runner) a session runs
 * on. Written by the scheduler on an accepted dispatch and read by the
 * dispatch route — placement candidates and workspace declarations gate only
 * NEW sessions, because a pinned session that re-ran placement could land on
 * another runner and split the SDK conversation in half.
 *
 * The pin is immutable: `INSERT OR IGNORE`, first pin wins. Moving a session
 * is §21.6 migration — a deliberate future design, not a side effect of a
 * dispatch.
 *
 * Like active_runs and run_events there are no foreign keys: the ids were
 * validated upstream by the route that owns placement.
 */

import type { Database } from "bun:sqlite";

export type SessionPin = {
  sessionId: string;
  ownerId: string;
  workspaceId: string;
  runnerId: string;
};

export type EnsureSessionPinInput = {
  sessionId: string;
  ownerId: string;
  workspaceId: string;
  runnerId: string;
};

export function ensureSessionPin(db: Database, input: EnsureSessionPinInput): void {
  db.query(
    `INSERT OR IGNORE INTO sessions (id, owner_id, workspace_id, runner_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.sessionId, input.ownerId, input.workspaceId, input.runnerId, Date.now());
}

export function sessionPin(db: Database, sessionId: string): SessionPin | undefined {
  const row = db
    .query("SELECT id, owner_id, workspace_id, runner_id FROM sessions WHERE id = ?")
    .get(sessionId) as
    | { id: string; owner_id: string; workspace_id: string; runner_id: string }
    | null;
  return row === null
    ? undefined
    : {
        sessionId: row.id,
        ownerId: row.owner_id,
        workspaceId: row.workspace_id,
        runnerId: row.runner_id,
      };
}
