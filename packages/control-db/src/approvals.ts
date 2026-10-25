import type { Database } from "bun:sqlite";

/**
 * The approvals projection (§13).
 *
 * `approval.requested` events land here so a decision route can validate,
 * close, and answer from one row without scanning the journal. The lifecycle
 * is a strict CAS chain — pending → decided → resolved — and every transition
 * checks `changes` on the UPDATE, because a replayed event or a
 * double-submitted decision must never write twice:
 *
 *   pending   — projected from `approval.requested`, waiting for the user
 *   decided   — a decision is recorded; the command is in the outbox
 *   resolved  — the runner's `approval.resolved` confirmed the outcome
 *   expired   — the runner reported a non-user terminal (`approval.expired`)
 *
 * The command row this module inserts (`approval.respond`) is written in the
 * SAME transaction as the decision it records: a decision that the server has
 * "accepted" without a durable command is a card stranded forever, which is
 * exactly the failure §13.1 forbids.
 */

/** What the runner is asking about — a tool permission or a user question. */
export type ApprovalKind = "tool_permission" | "user_question";

export type UpsertApprovalRequestedInput = {
  approvalId: string;
  sessionId: string;
  runId: string;
  runnerId: string;
  kind: ApprovalKind;
  toolName: string;
  inputHash: string;
  inputSummary: string;
  /** Epoch ms at which the runner stops honoring a decision. */
  expiresAt: number;
  now?: number;
};

export type ApprovalRecord = {
  sessionId: string;
  runnerId: string;
  state: string;
  inputHash: string;
  kind: ApprovalKind;
  toolName: string;
  inputSummary: string;
  expiresAt: number;
};

export type DecisionOutcome =
  | { ok: true; runnerId: string; inputHash: string; sessionId: string }
  | { ok: false; reason: "unknown" | "not_pending" };

type ApprovalRow = {
  session_id: string;
  runner_id: string;
  state: string;
  kind: string;
  tool_name: string;
  input_hash: string;
  input_summary: string;
  expires_at: number;
};

/**
 * Project an `approval.requested` into a pending row. `INSERT OR IGNORE`
 * keeps replay idempotent: at-least-once delivery means the identical event
 * arrives twice, and the first observation is the one that counts.
 */
export function upsertApprovalRequested(db: Database, input: UpsertApprovalRequestedInput): void {
  db.prepare(
    `INSERT OR IGNORE INTO approvals
       (approval_id, session_id, run_id, runner_id, kind, tool_name,
        input_hash, input_summary, expires_at, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    input.approvalId,
    input.sessionId,
    input.runId,
    input.runnerId,
    input.kind,
    input.toolName,
    input.inputHash,
    input.inputSummary,
    input.expiresAt,
    input.now ?? Date.now(),
  );
}

/** One approval with its session context, or undefined when unknown. */
export function approvalForSession(db: Database, approvalId: string): ApprovalRecord | undefined {
  const row = db
    .prepare(
      `SELECT session_id, runner_id, state, kind, tool_name, input_hash, input_summary, expires_at
       FROM approvals WHERE approval_id = ?`,
    )
    .get(approvalId) as ApprovalRow | null;
  if (row === null) return undefined;

  return {
    sessionId: row.session_id,
    runnerId: row.runner_id,
    state: row.state,
    kind: row.kind as ApprovalKind,
    toolName: row.tool_name,
    inputHash: row.input_hash,
    inputSummary: row.input_summary,
    expiresAt: row.expires_at,
  };
}

/**
 * Record the user's decision and enqueue the `approval.respond` command in
 * ONE transaction. The CAS `pending → decided` is the once-guard: only the
 * first decision wins, everything else answers `not_pending` — including the
 * runner's own redeliveries racing a user's second click.
 */
export function recordApprovalDecision(db: Database, input: DecisionInput): DecisionOutcome {
  const now = input.now ?? Date.now();

  const tx = db.transaction((): DecisionOutcome => {
    // The CAS and the reads happen inside the same transaction, so the
    // decision, the audit row, and the command commit — or none of them do.
    const claimed = db
      .prepare(
        `UPDATE approvals SET state = 'decided'
         WHERE approval_id = ? AND state = 'pending'`,
      )
      .run(input.approvalId);
    if (claimed.changes === 0) {
      const exists = db
        .prepare("SELECT 1 FROM approvals WHERE approval_id = ?")
        .get(input.approvalId);
      return exists === null ? { ok: false, reason: "unknown" } : { ok: false, reason: "not_pending" };
    }

    const row = db
      .prepare(
        "SELECT session_id, run_id, runner_id, input_hash FROM approvals WHERE approval_id = ?",
      )
      .get(input.approvalId) as {
      session_id: string;
      run_id: string;
      runner_id: string;
      input_hash: string;
    };

    db.prepare(
      `INSERT INTO approval_decisions (approval_id, decision, answers_json, decided_at)
       VALUES (?, ?, ?, ?)`,
    ).run(input.approvalId, input.decision, input.answersJson ?? null, now);

    // The command's payload names the exact approval and the hash the runner
    // is holding — the runner re-validates both before resolving its callback.
    const payload = JSON.stringify({
      approvalId: input.approvalId,
      decision: input.decision,
      answers: input.answersJson === undefined ? null : JSON.parse(input.answersJson),
      inputHash: row.input_hash,
    });
    db.prepare(
      `INSERT INTO command_outbox
         (command_id, runner_id, kind, payload, fingerprint, issued_at, expires_at,
          session_id, run_id, attempt_id, workspace_id,
          delivery_state, attempt_count, created_at)
       VALUES (?, ?, 'approval.respond', ?, ?, ?, NULL, ?, ?, NULL, NULL, 'pending', 0, ?)`,
    ).run(
      input.outbox.commandId,
      row.runner_id,
      payload,
      input.outbox.fingerprint,
      new Date(now).toISOString(),
      row.session_id,
      row.run_id,
      now,
    );

    return { ok: true, runnerId: row.runner_id, inputHash: row.input_hash, sessionId: row.session_id };
  });

  return tx();
}

type DecisionInput = {
  approvalId: string;
  decision: "allow" | "deny";
  answersJson?: string;
  outbox: { commandId: string; fingerprint: string };
  now?: number;
};

/**
 * Close an approval on the runner's terminal report: `pending|decided →
 * resolved|expired`. `decided → resolved` is the normal path (the decision
 * was recorded first, the runner's outcome event arrives after); an already
 * terminal row refuses a second close.
 */
export function closeApproval(
  db: Database,
  input: { approvalId: string; state: "resolved" | "expired"; now?: number },
): boolean {
  const result = db
    .prepare(
      `UPDATE approvals SET state = ?
       WHERE approval_id = ? AND state IN ('pending', 'decided')`,
    )
    .run(input.state, input.approvalId);
  return result.changes > 0;
}
