/**
 * Central command outbox (§9.3, §12.2, §18.1).
 *
 * Every command is written here before it is sent. That order is the whole
 * design: a command sent but not recorded is lost work, while one recorded but
 * not sent is recoverable on the next drain.
 *
 * Delivery states:
 *
 *   pending → sent → accepted      (the runner has it; the command is retired)
 *              └──→ rejected        (retired with a reason)
 *
 * `sent` does not mean "delivered". It means "handed to a socket", which may
 * have died before the bytes arrived. So `pendingFor` still returns `sent`
 * commands: at-least-once is the contract, and the runner's inbox — which
 * dedupes by command id and fingerprint — is what makes a redelivery harmless.
 *
 * The fingerprint is immutable per command id. Reusing an id with different
 * content is rejected rather than overwritten, because the runner would
 * otherwise accept whichever version arrived first and silently ignore the other.
 */

import type { Database } from "bun:sqlite";
import { fingerprint } from "@cc-web/shared";

export type CommandKind =
  | "run.start"
  | "run.cancel"
  | "approval.respond"
  | "workspace.file.write"
  | "workspace.file.revert"
  | "workspace.inspect"
  | "config.inspect";

export type EnqueueInput = {
  commandId: string;
  runnerId: string;
  kind: CommandKind;
  payload: unknown;
  issuedAt: string;
  expiresAt?: string;
  runId?: string;
  attemptId?: string;
  sessionId?: string;
  workspaceId?: string;
};

export type DeliveryState = "pending" | "sent" | "accepted" | "rejected";

export type OutboxCommand = {
  commandId: string;
  runnerId: string;
  kind: CommandKind;
  payload: unknown;
  issuedAt: string;
  expiresAt: string | undefined;
  deliveryState: DeliveryState;
  attemptCount: number;
  attemptId: string | undefined;
  sessionId: string | undefined;
  runId: string | undefined;
  workspaceId: string | undefined;
  rejectionReason: string | undefined;
};

type Row = {
  command_id: string;
  runner_id: string;
  kind: string;
  payload: string;
  fingerprint: string;
  issued_at: string;
  expires_at: string | null;
  session_id: string | null;
  run_id: string | null;
  attempt_id: string | null;
  workspace_id: string | null;
  delivery_state: string;
  attempt_count: number;
  rejection_reason: string | null;
};

/** Terminal states never transition again; a late receipt must not reopen one. */
const TERMINAL: ReadonlySet<DeliveryState> = new Set(["accepted", "rejected"]);

export class CommandOutbox {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async enqueue(input: EnqueueInput): Promise<void> {
    const fp = await fingerprintOf(input);
    const existing = this.#row(input.commandId);

    if (existing) {
      if (existing.fingerprint !== fp) {
        throw new Error(`command ${input.commandId} already exists with a different fingerprint`);
      }
      // Identical re-enqueue is a retry by the caller, not an error.
      return;
    }

    this.insertPendingSync(input, fp);
  }

  /**
   * The enqueue INSERT without the async fingerprint step, for callers that
   * computed the fingerprint BEFORE opening a transaction (§13.1): the
   * decision route hashes first, then commits decision + command in one
   * atomic write. A duplicate command id still fails on the primary key —
   * the CAS guarding the caller's transaction is what prevents reaching here
   * twice.
   */
  insertPendingSync(input: EnqueueInput, fingerprint: string): void {
    this.#db
      .query(
        `INSERT INTO command_outbox
           (command_id, runner_id, kind, payload, fingerprint, issued_at, expires_at,
            session_id, run_id, attempt_id, workspace_id,
            delivery_state, attempt_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      )
      .run(
        input.commandId,
        input.runnerId,
        input.kind,
        JSON.stringify(input.payload ?? null),
        fingerprint,
        input.issuedAt,
        input.expiresAt ?? null,
        input.sessionId ?? null,
        input.runId ?? null,
        input.attemptId ?? null,
        input.workspaceId ?? null,
        Date.now(),
      );
  }

  /**
   * Commands this runner should receive now: everything not yet accepted or
   * rejected, minus anything that has expired against `now`.
   */
  pendingFor(runnerId: string, options: { now?: Date } = {}): OutboxCommand[] {
    const now = (options.now ?? new Date()).toISOString();

    const rows = this.#db
      .query(
        `SELECT * FROM command_outbox
          WHERE runner_id = ?
            AND delivery_state NOT IN ('accepted', 'rejected')
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY created_at ASC, command_id ASC`,
      )
      .all(runnerId, now) as Row[];

    return rows.map(toCommand);
  }

  /**
   * Retire commands that expired before they could be delivered, and report
   * which ones.
   *
   * `pendingFor` already filters them out, which keeps them from being sent —
   * but it would leave them `pending` for the life of the database. An operator
   * watching outbox age would see work that is never going to move, and nothing
   * would ever tell them why.
   */
  retireExpired(runnerId: string, now: Date = new Date()): string[] {
    const rows = this.#db
      .query(
        `SELECT command_id FROM command_outbox
          WHERE runner_id = ?
            AND delivery_state NOT IN ('accepted', 'rejected')
            AND expires_at IS NOT NULL
            AND expires_at <= ?`,
      )
      .all(runnerId, now.toISOString()) as Array<{ command_id: string }>;

    const ids = rows.map((row) => row.command_id);
    for (const id of ids) this.markRejected(id, "expired");
    return ids;
  }

  markSent(commandId: string): void {
    const row = this.#require(commandId);
    if (TERMINAL.has(row.delivery_state as DeliveryState)) return;

    this.#db
      .query(
        `UPDATE command_outbox
            SET delivery_state = 'sent', attempt_count = attempt_count + 1, last_sent_at = ?
          WHERE command_id = ?`,
      )
      .run(Date.now(), commandId);
  }

  markAccepted(commandId: string, attemptId: string): void {
    const row = this.#require(commandId);
    // A receipt that arrives after a rejection describes a delivery we already
    // gave up on. Reopening it would contradict what the rest of the system was
    // told, so the terminal state wins.
    if (row.delivery_state === "rejected") return;

    // `attempt_id` is the attempt the command was *issued for*. A receipt naming
    // a different one is a conflict to report, not a correction to apply: taking
    // it would rewrite which attempt this command belonged to after the fact.
    // Only when the issue-time attempt was unknown does the receipt fill it in.
    const attempt = row.attempt_id ?? attemptId;

    this.#db
      .query(
        `UPDATE command_outbox
            SET delivery_state = 'accepted', attempt_id = ?, accepted_at = ?
          WHERE command_id = ?`,
      )
      .run(attempt, Date.now(), commandId);
  }

  markRejected(commandId: string, reason: string): void {
    const row = this.#require(commandId);
    if (row.delivery_state === "accepted") return;

    this.#db
      .query(
        `UPDATE command_outbox
            SET delivery_state = 'rejected', rejection_reason = ?, rejected_at = ?
          WHERE command_id = ?`,
      )
      .run(reason, Date.now(), commandId);
  }

  /**
   * Retire a command that was answered without a receipt (§23 Ruling 2).
   *
   * An inspection is not an attempt, so its answer (`rpc.result`) is the only
   * proof it was served, and there is no attempt id to record. Marking it
   * through `markAccepted` would write `""` into `attempt_id` and leave a row
   * that claims an attempt nobody made; leaving it alone would keep it
   * deliverable until it expired, and then audit a succeeded read as "expired".
   * Terminal states stay terminal, exactly like the other transitions.
   */
  markAnswered(commandId: string): void {
    const row = this.#require(commandId);
    if (TERMINAL.has(row.delivery_state as DeliveryState)) return;

    this.#db
      .query(
        `UPDATE command_outbox
            SET delivery_state = 'accepted', accepted_at = ?
          WHERE command_id = ?`,
      )
      .run(Date.now(), commandId);
  }

  get(commandId: string): OutboxCommand | undefined {
    const row = this.#row(commandId);
    return row ? toCommand(row) : undefined;
  }

  #row(commandId: string): Row | undefined {
    return (
      (this.#db
        .query("SELECT * FROM command_outbox WHERE command_id = ?")
        .get(commandId) as Row | null) ?? undefined
    );
  }

  #require(commandId: string): Row {
    const row = this.#row(commandId);
    if (!row) {
      // A receipt for a command nobody enqueued is a protocol error. Recording
      // it would create a row that looks like delivered work.
      throw new Error(`unknown command: ${commandId}`);
    }
    return row;
  }
}

export async function fingerprintOf(input: EnqueueInput): Promise<string> {
  // Canonicalised so key order and `undefined` do not change the hash; without
  // that, an identical retry would look like a different command.
  return fingerprint({
    commandId: input.commandId,
    runnerId: input.runnerId,
    kind: input.kind,
    payload: input.payload ?? null,
  });
}

function toCommand(row: Row): OutboxCommand {
  return {
    commandId: row.command_id,
    runnerId: row.runner_id,
    kind: row.kind as CommandKind,
    payload: JSON.parse(row.payload) as unknown,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at ?? undefined,
    deliveryState: row.delivery_state as DeliveryState,
    attemptCount: row.attempt_count,
    attemptId: row.attempt_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    runId: row.run_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    rejectionReason: row.rejection_reason ?? undefined,
  };
}
