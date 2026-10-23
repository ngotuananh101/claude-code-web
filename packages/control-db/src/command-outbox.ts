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
  delivery_state: string;
  attempt_count: number;
  attempt_id: string | null;
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

    this.#db
      .query(
        `INSERT INTO command_outbox
           (command_id, runner_id, kind, payload, fingerprint, issued_at, expires_at,
            delivery_state, attempt_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      )
      .run(
        input.commandId,
        input.runnerId,
        input.kind,
        JSON.stringify(input.payload ?? null),
        fp,
        input.issuedAt,
        input.expiresAt ?? null,
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

    this.#db
      .query(
        `UPDATE command_outbox
            SET delivery_state = 'accepted', attempt_id = ?, accepted_at = ?
          WHERE command_id = ?`,
      )
      .run(attemptId, Date.now(), commandId);
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

async function fingerprintOf(input: EnqueueInput): Promise<string> {
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
    rejectionReason: row.rejection_reason ?? undefined,
  };
}
