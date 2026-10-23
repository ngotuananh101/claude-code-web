import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * One-time enrollment tokens (§6.1).
 *
 * A token is shown to the operator exactly once, at creation. Only its hash is
 * stored. Consumption is a single conditional UPDATE so that two Runners racing
 * on the same token cannot both enroll.
 */

const TOKEN_PREFIX = "ccr_";

export type CreatedEnrollment = {
  /** Returned once and never persisted. */
  token: string;
  id: string;
  expiresAt: number;
};

export type ConsumedEnrollment =
  | { ok: true; enrollment: { id: string; ownerId: string } }
  | { ok: false; reason: "unknown" | "expired" | "consumed" };

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createEnrollment(
  db: Database,
  opts: { ownerId: string; ttlMs: number; now?: number },
): CreatedEnrollment {
  const now = opts.now ?? Date.now();
  const id = randomUUID();
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const expiresAt = now + opts.ttlMs;

  db.prepare(
    `INSERT INTO enrollments (id, owner_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, opts.ownerId, hashToken(token), now, expiresAt);

  return { token, id, expiresAt };
}

export function consumeEnrollment(
  db: Database,
  opts: { token: string; now?: number },
): ConsumedEnrollment {
  const now = opts.now ?? Date.now();
  const tokenHash = hashToken(opts.token);

  const row = db
    .prepare("SELECT id, owner_id, expires_at, consumed_at FROM enrollments WHERE token_hash = ?")
    .get(tokenHash) as
    | { id: string; owner_id: string; expires_at: number; consumed_at: number | null }
    | null;

  if (!row) return { ok: false, reason: "unknown" };
  if (row.consumed_at !== null) return { ok: false, reason: "consumed" };
  if (now >= row.expires_at) return { ok: false, reason: "expired" };

  // Conditional update: the WHERE clause is what makes consumption atomic. If a
  // concurrent caller won the race, changes === 0 and we must not report success.
  const result = db
    .prepare(
      `UPDATE enrollments SET consumed_at = ?
       WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .run(now, tokenHash, now);

  if (result.changes !== 1) return { ok: false, reason: "consumed" };

  return { ok: true, enrollment: { id: row.id, ownerId: row.owner_id } };
}
