import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * Runner credentials (§6.1, §6.3).
 *
 * Issued once at enrollment and returned only to the Runner. Only the hash is
 * stored, so a control-plane database leak does not hand out runner identities.
 *
 * Rotation issues a new secret and revokes the previous one in the same
 * transaction: there is never a window where a Runner holds two live secrets.
 */

const CREDENTIAL_PREFIX = "cck_";

export type VerifiedRunner =
  | { ok: true; runnerId: string; ownerId: string }
  | { ok: false; reason: "unknown" | "revoked" };

export type RevokeResult = { ok: true } | { ok: false; reason: "not_found" };

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function issueRunnerCredential(
  db: Database,
  opts: { id: string; ownerId: string; now?: number },
): { credential: string } {
  const now = opts.now ?? Date.now();
  const credential = `${CREDENTIAL_PREFIX}${randomBytes(32).toString("base64url")}`;

  const tx = db.transaction(() => {
    // Upsert the runner identity: enrollment and rotation both land here.
    db.prepare(
      `INSERT INTO runners (id, owner_id, created_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    ).run(opts.id, opts.ownerId, now);

    // Rotation: every previously issued secret for this runner dies now.
    db.prepare(
      `UPDATE runner_credentials SET revoked_at = ?
       WHERE runner_id = ? AND revoked_at IS NULL`,
    ).run(now, opts.id);

    db.prepare(
      `INSERT INTO runner_credentials (id, runner_id, secret_hash, issued_at)
       VALUES (?, ?, ?, ?)`,
    ).run(randomUUID(), opts.id, hashSecret(credential), now);
  });

  tx();
  return { credential };
}

export function verifyRunnerCredential(db: Database, credential: string): VerifiedRunner {
  const row = db
    .prepare(
      `SELECT c.runner_id, c.revoked_at, r.owner_id, r.revoked_at AS runner_revoked_at
       FROM runner_credentials c
       JOIN runners r ON r.id = c.runner_id
       WHERE c.secret_hash = ?`,
    )
    .get(hashSecret(credential)) as
    | {
        runner_id: string;
        revoked_at: number | null;
        owner_id: string;
        runner_revoked_at: number | null;
      }
    | null;

  if (!row) return { ok: false, reason: "unknown" };
  if (row.revoked_at !== null || row.runner_revoked_at !== null) {
    return { ok: false, reason: "revoked" };
  }

  return { ok: true, runnerId: row.runner_id, ownerId: row.owner_id };
}

export function revokeRunner(
  db: Database,
  opts: { runnerId: string; ownerId: string; now?: number },
): RevokeResult {
  const now = opts.now ?? Date.now();

  const tx = db.transaction(() => {
    const updated = db
      .prepare(
        `UPDATE runners SET revoked_at = ?
         WHERE id = ? AND owner_id = ? AND revoked_at IS NULL`,
      )
      .run(now, opts.runnerId, opts.ownerId);

    if (updated.changes !== 1) return false;

    db.prepare(
      `UPDATE runner_credentials SET revoked_at = ?
       WHERE runner_id = ? AND revoked_at IS NULL`,
    ).run(now, opts.runnerId);

    return true;
  });

  return tx() ? { ok: true } : { ok: false, reason: "not_found" };
}
