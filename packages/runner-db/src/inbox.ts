import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { canonicalize } from "@cc-web/shared";

/**
 * Runner command inbox (§9.3).
 *
 * Guarantees, in order of importance:
 *
 *  1. A command ID is accepted at most once. Re-delivery returns the stored
 *     receipt so the caller never re-runs the SDK for it.
 *  2. The same ID with a different payload is rejected and audited, never
 *     silently accepted as a new command.
 *  3. Expired commands and commands for another runner are rejected before
 *     anything is persisted, so a stale start cannot launch later (§9.5).
 */

export type CommandEnvelope = {
  protocolVersion: number;
  commandId: string;
  runnerId: string;
  kind: string;
  issuedAt: string;
  expiresAt?: string;
  payload: unknown;
  sessionId?: string;
  runId?: string;
  attemptId?: string;
  assignmentEpoch?: number;
  workspaceId?: string;
};

export type InboxState = "accepted" | "running" | "finished" | "failed";

export type AcceptResult =
  | { ok: true; duplicate: boolean; state: InboxState }
  | {
      ok: false;
      reason:
        | "unsupported_protocol"
        | "wrong_runner"
        | "expired"
        | "fingerprint_mismatch";
    };

const SUPPORTED_PROTOCOL_VERSION = 1;

/**
 * Fingerprint of the semantic content of a command.
 *
 * Key order is not semantic, so we canonicalize before hashing. The protocol
 * version is part of the input: a command means something different under a
 * different protocol, and must not collide with its predecessor (§9.1).
 */
export function fingerprintCommand(command: CommandEnvelope): string {
  const canonical = canonicalize({
    protocolVersion: command.protocolVersion,
    kind: command.kind,
    runnerId: command.runnerId,
    workspaceId: command.workspaceId,
    sessionId: command.sessionId,
    runId: command.runId,
    attemptId: command.attemptId,
    assignmentEpoch: command.assignmentEpoch,
    payload: command.payload,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function acceptCommand(
  db: Database,
  command: CommandEnvelope,
  opts: { now?: number; localRunnerId?: string } = {},
): AcceptResult {
  const now = opts.now ?? Date.now();

  if (command.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
    reject(db, command.commandId, "unsupported_protocol", now);
    return { ok: false, reason: "unsupported_protocol" };
  }

  if (opts.localRunnerId && command.runnerId !== opts.localRunnerId) {
    reject(db, command.commandId, "wrong_runner", now);
    return { ok: false, reason: "wrong_runner" };
  }

  if (command.expiresAt !== undefined) {
    const expiry = Date.parse(command.expiresAt);
    if (Number.isFinite(expiry) && now >= expiry) {
      reject(db, command.commandId, "expired", now);
      return { ok: false, reason: "expired" };
    }
  }

  const fingerprint = fingerprintCommand(command);

  const existing = db
    .prepare("SELECT fingerprint, state FROM command_inbox WHERE command_id = ?")
    .get(command.commandId) as { fingerprint: string; state: InboxState } | null;

  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      // Same ID, different meaning. Accepting it would let a stale or hostile
      // sender redirect a command that was already scheduled.
      reject(db, command.commandId, "fingerprint_mismatch", now);
      return { ok: false, reason: "fingerprint_mismatch" };
    }
    return { ok: true, duplicate: true, state: existing.state };
  }

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO command_inbox
         (command_id, runner_id, kind, fingerprint, state, payload, accepted_at, updated_at)
       VALUES (?, ?, ?, ?, 'accepted', ?, ?, ?)`,
    ).run(
      command.commandId,
      command.runnerId,
      command.kind,
      fingerprint,
      JSON.stringify(command.payload ?? null),
      now,
      now,
    );
  });

  tx();
  return { ok: true, duplicate: false, state: "accepted" };
}

function reject(
  db: Database,
  commandId: string,
  reason: string,
  now: number,
): void {
  db.prepare(
    "INSERT INTO inbox_rejections (command_id, reason, rejected_at) VALUES (?, ?, ?)",
  ).run(commandId, reason, now);
}
