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
import { deleteSessionHistory } from "./session-history.ts";

export type SessionPin = {
  sessionId: string;
  ownerId: string;
  workspaceId: string;
  runnerId: string;
  title?: string | null | undefined;
};

export type EnsureSessionPinInput = {
  sessionId: string;
  ownerId: string;
  workspaceId: string;
  runnerId: string;
  title?: string;
};

export function ensureSessionPin(db: Database, input: EnsureSessionPinInput): void {
  // `INSERT OR IGNORE` swallows a NOT NULL violation exactly as it swallows the
  // duplicate-key race it exists for: the write vanishes, no error is raised,
  // and the next `sessionPin` reads back "no pin". A caller that then refuses on
  // a pin contradiction reports the wrong cause — a dispatch missing `ownerId`
  // surfaced as `session_pinned`, which reads as "this session lives on another
  // runner". Both cases are silent, so check the required fields here, where the
  // field name is still known. An embedder inside a template string sees no type
  // error for this, which is how it reaches production at all.
  requirePinField(input.ownerId, "ownerId");
  requirePinField(input.workspaceId, "workspaceId");
  requirePinField(input.runnerId, "runnerId");
  requirePinField(input.sessionId, "sessionId");

  db.query(
    `INSERT OR IGNORE INTO sessions (id, owner_id, workspace_id, runner_id, created_at, title)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.sessionId,
    input.ownerId,
    input.workspaceId,
    input.runnerId,
    Date.now(),
    input.title ?? null,
  );
}

/** The `sessions` columns are NOT NULL; reject a missing value before SQLite eats it. */
function requirePinField(value: unknown, field: string): void {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`ensureSessionPin: ${field} is required and must be a non-empty string`);
  }
}

export function updateSessionTitle(
  db: Database,
  sessionId: string,
  ownerId: string,
  title: string,
): boolean {
  const result = db
    .prepare("UPDATE sessions SET title = ? WHERE id = ? AND owner_id = ?")
    .run(title.trim(), sessionId, ownerId);
  return result.changes > 0;
}

export function deleteSession(
  db: Database,
  sessionId: string,
  ownerId: string,
): { ok: boolean; attachmentStoragePaths: string[] } {
  const session = db
    .query("SELECT id FROM sessions WHERE id = ? AND owner_id = ?")
    .get(sessionId, ownerId);
  if (!session) {
    return { ok: false, attachmentStoragePaths: [] };
  }

  const txn = db.transaction(() => {
    // Collect attachment storage paths before they're deleted; the caller
    // (the control server) will instruct the runner to remove the files on disk.
    const attachmentRows = db
      .query("SELECT storage_path FROM session_attachments WHERE session_id = ? AND owner_id = ?")
      .all(sessionId, ownerId) as Array<{ storage_path: string }>;
    const attachmentStoragePaths = attachmentRows.map((row) => row.storage_path);

    db.prepare("DELETE FROM session_attachments WHERE session_id = ? AND owner_id = ?").run(
      sessionId,
      ownerId,
    );
    db.prepare(
      "DELETE FROM approval_decisions WHERE approval_id IN (SELECT approval_id FROM approvals WHERE session_id = ?)",
    ).run(sessionId);
    db.prepare("DELETE FROM approvals WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM active_runs WHERE session_id = ?").run(sessionId);
    deleteSessionHistory(db, sessionId);
    db.prepare("DELETE FROM run_events WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM command_outbox WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);

    return attachmentStoragePaths;
  });

  const attachmentStoragePaths = txn();
  return { ok: true, attachmentStoragePaths };
}

export function sessionPin(db: Database, sessionId: string): SessionPin | undefined {
  const row = db
    .query("SELECT id, owner_id, workspace_id, runner_id, title FROM sessions WHERE id = ?")
    .get(sessionId) as {
    id: string;
    owner_id: string;
    workspace_id: string;
    runner_id: string;
    title?: string | null;
  } | null;
  return row === null
    ? undefined
    : {
        sessionId: row.id,
        ownerId: row.owner_id,
        workspaceId: row.workspace_id,
        runnerId: row.runner_id,
        title: row.title ?? undefined,
      };
}
