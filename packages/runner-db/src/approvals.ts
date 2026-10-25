import type { Database } from "bun:sqlite";

/**
 * Runner-local pending approvals (§13).
 *
 * While the SDK's `canUseTool` callback is parked, this table is the gate's
 * durable memory: an incoming `approval.respond` command must name an id that
 * exists here, carry the same `input_hash`, and find the row still `pending`
 * before the callback it references may resolve. The CAS in `finishApproval`
 * is the once-guard — a replayed command, a second decision, or a late one
 * after expiry all find `changes = 0` and are refused.
 */

export type PendingApprovalKind = "tool_permission" | "user_question";

export type InsertPendingApprovalInput = {
  approvalId: string;
  attemptId: string;
  toolCallId: string;
  inputHash: string;
  callbackGeneration: number;
  kind: PendingApprovalKind;
  /** Epoch ms after which the router denies this callback on its own. */
  expiresAt: number;
  now?: number;
};

export type PendingApproval = {
  approvalId: string;
  attemptId: string;
  toolCallId: string;
  inputHash: string;
  callbackGeneration: number;
  kind: PendingApprovalKind;
  expiresAt: number;
  state: string;
};

export function insertPendingApproval(
  db: Database,
  input: InsertPendingApprovalInput,
): { ok: true } | { ok: false; reason: "duplicate" } {
  try {
    db.prepare(
      `INSERT INTO pending_approvals
         (approval_id, attempt_id, tool_call_id, input_hash, callback_generation,
          kind, expires_at, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(
      input.approvalId,
      input.attemptId,
      input.toolCallId,
      input.inputHash,
      String(input.callbackGeneration),
      input.kind,
      input.expiresAt,
      input.now ?? Date.now(),
    );
  } catch (error) {
    if (!/UNIQUE constraint failed/i.test((error as Error).message)) throw error;
    return { ok: false, reason: "duplicate" };
  }
  return { ok: true };
}

export function pendingApproval(db: Database, approvalId: string): PendingApproval | undefined {
  const row = db
    .prepare(
      `SELECT approval_id, attempt_id, tool_call_id, input_hash, callback_generation,
              kind, expires_at, state
       FROM pending_approvals WHERE approval_id = ?`,
    )
    .get(approvalId) as
    | {
        approval_id: string;
        attempt_id: string;
        tool_call_id: string;
        input_hash: string;
        callback_generation: string;
        kind: string;
        expires_at: number;
        state: string;
      }
    | null;
  if (row === null) return undefined;

  return {
    approvalId: row.approval_id,
    attemptId: row.attempt_id,
    toolCallId: row.tool_call_id,
    inputHash: row.input_hash,
    callbackGeneration: Number(row.callback_generation),
    kind: row.kind as PendingApprovalKind,
    expiresAt: row.expires_at,
    state: row.state,
  };
}

/**
 * CAS the row out of `pending` exactly once: the first caller to flip it wins
 * and may resolve the parked callback; every later caller sees `false`.
 */
export function finishApproval(
  db: Database,
  input: { approvalId: string; state: "resolved" | "expired"; now?: number },
): boolean {
  const result = db
    .prepare(
      `UPDATE pending_approvals SET state = ?
       WHERE approval_id = ? AND state = 'pending'`,
    )
    .run(input.state, input.approvalId);
  return result.changes > 0;
}
