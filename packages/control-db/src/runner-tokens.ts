import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";

/**
 * Web-minted connector tokens (§6.1, ADR-0002 — the cloudflared model).
 *
 * The owner creates a runner on the web; the server mints a UUID token, shows
 * it exactly once, and stores only its SHA-256. The runner proves itself with
 * that token over the Bearer header on every connect — there is no enrollment
 * round-trip to redeem, because the token *is* the standing credential.
 *
 * A UUIDv4 carries 122 random bits, which is the whole security budget of a
 * bearer secret here; the format buys operator familiarity and a header-safe,
 * unambiguous string.
 */

export type MintedRunnerToken = {
  runnerId: string;
  /** Returned once and never persisted. */
  token: string;
};

export type ListedRunner = {
  runnerId: string;
  name?: string | null;
  createdAt: number;
  revokedAt: number | null;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createRunnerToken(
  db: Database,
  opts: { ownerId: string; runnerId?: string; now?: number },
): MintedRunnerToken {
  const now = opts.now ?? Date.now();
  const runnerId = opts.runnerId ?? randomUUID();
  const token = randomUUID();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO runners (id, owner_id, created_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    ).run(runnerId, opts.ownerId, now);

    // Rotation: every previously issued secret for this runner dies now, in
    // the same transaction — there is never a window with two live tokens.
    db.prepare(
      `UPDATE runner_credentials SET revoked_at = ?
       WHERE runner_id = ? AND revoked_at IS NULL`,
    ).run(now, runnerId);

    db.prepare(
      `INSERT INTO runner_credentials (id, runner_id, secret_hash, issued_at)
       VALUES (?, ?, ?, ?)`,
    ).run(randomUUID(), runnerId, hashToken(token), now);
  });

  tx();
  return { runnerId, token };
}

/**
 * The runners one owner holds (§5.2, §17). Owner-scoped like every other
 * listing in this package: a runner's existence is not secret material, but a
 * registry answering another owner's topology is still the wrong answer.
 */
export function listRunners(db: Database, ownerId: string): ListedRunner[] {
  return db
    .prepare(
      `SELECT id, name, created_at, revoked_at FROM runners
       WHERE owner_id = ? ORDER BY created_at DESC`,
    )
    .all(ownerId)
    .map((row) => {
      const record = row as {
        id: string;
        name: string | null;
        created_at: number;
        revoked_at: number | null;
      };
      return {
        runnerId: record.id,
        name: record.name ?? undefined,
        createdAt: record.created_at,
        revokedAt: record.revoked_at,
      };
    });
}

export function updateRunnerName(
  db: Database,
  runnerId: string,
  ownerId: string,
  name: string,
): boolean {
  const result = db
    .prepare("UPDATE runners SET name = ? WHERE id = ? AND owner_id = ?")
    .run(name.trim(), runnerId, ownerId);
  return result.changes > 0;
}

export function deleteRunner(
  db: Database,
  runnerId: string,
  ownerId: string,
): { ok: boolean; deletedSessions: string[] } {
  const runner = db
    .query("SELECT id FROM runners WHERE id = ? AND owner_id = ?")
    .get(runnerId, ownerId);
  if (!runner) return { ok: false, deletedSessions: [] };

  const sessionRows = db
    .query("SELECT id FROM sessions WHERE runner_id = ? AND owner_id = ?")
    .all(runnerId, ownerId) as Array<{ id: string }>;
  const deletedSessions = sessionRows.map((r) => r.id);

  const txn = db.transaction(() => {
    // Delete all sessions attached to this runner
    for (const sid of deletedSessions) {
      db.prepare("DELETE FROM approvals WHERE session_id = ?").run(sid);
      db.prepare("DELETE FROM active_runs WHERE session_id = ?").run(sid);
      db.prepare("DELETE FROM run_events WHERE session_id = ?").run(sid);
      db.prepare("DELETE FROM command_outbox WHERE session_id = ?").run(sid);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(sid);
    }
    // Delete runner-level rows
    db.prepare("DELETE FROM workspaces WHERE runner_id = ?").run(runnerId);
    db.prepare("DELETE FROM runner_credentials WHERE runner_id = ?").run(runnerId);
    db.prepare("DELETE FROM command_outbox WHERE runner_id = ?").run(runnerId);
    db.prepare("DELETE FROM runners WHERE id = ?").run(runnerId);
  });
  txn();

  return { ok: true, deletedSessions };
}
