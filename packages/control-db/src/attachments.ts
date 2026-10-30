/**
 * Session attachment storage (§4.4).
 *
 * Each attachment is a file on the runner's disk that the owner uploaded to or
 * generated for a session. The control DB only stores the metadata that the
 * owner needs to enumerate and delete them; the bytes themselves live at
 * `storagePath` on the runner and are removed by the runner after this module
 * returns their paths.
 */

import type { Database } from "bun:sqlite";

export type SessionAttachmentRecord = {
  id: string;
  sessionId: string;
  ownerId: string;
  name: string;
  mimeType: string;
  size: number;
  storagePath: string;
  createdAt: number;
};

export function insertSessionAttachment(db: Database, record: SessionAttachmentRecord): void {
  db.query(
    `INSERT INTO session_attachments
      (id, session_id, owner_id, name, mime_type, size, storage_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.sessionId,
    record.ownerId,
    record.name,
    record.mimeType,
    record.size,
    record.storagePath,
    record.createdAt,
  );
}

export function getSessionAttachment(
  db: Database,
  id: string,
  ownerId: string,
): SessionAttachmentRecord | undefined {
  const row = db
    .query(
      `SELECT id, session_id AS sessionId, owner_id AS ownerId, name, mime_type AS mimeType,
            size, storage_path AS storagePath, created_at AS createdAt
     FROM session_attachments
     WHERE id = ? AND owner_id = ?`,
    )
    .get(id, ownerId) as {
    id: string;
    sessionId: string;
    ownerId: string;
    name: string;
    mimeType: string;
    size: number;
    storagePath: string;
    createdAt: number;
  } | null;

  return row === null ? undefined : row;
}

export function listSessionAttachments(
  db: Database,
  sessionId: string,
  ownerId: string,
): SessionAttachmentRecord[] {
  return db
    .query(
      `SELECT id, session_id AS sessionId, owner_id AS ownerId, name, mime_type AS mimeType,
            size, storage_path AS storagePath, created_at AS createdAt
     FROM session_attachments
     WHERE session_id = ? AND owner_id = ?
     ORDER BY created_at ASC`,
    )
    .all(sessionId, ownerId) as SessionAttachmentRecord[];
}

export function deleteSessionAttachments(
  db: Database,
  sessionId: string,
  ownerId: string,
): string[] {
  const rows = db
    .query(
      `SELECT storage_path AS storagePath
     FROM session_attachments
     WHERE session_id = ? AND owner_id = ?`,
    )
    .all(sessionId, ownerId) as Array<{ storagePath: string }>;

  const paths = rows.map((row) => row.storagePath);

  db.prepare(`DELETE FROM session_attachments WHERE session_id = ? AND owner_id = ?`).run(
    sessionId,
    ownerId,
  );

  return paths;
}
