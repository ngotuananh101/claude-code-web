/**
 * Central command outbox (§9.3, §12.2, §18.1).
 *
 * Every command is written here before it is sent. That order is the whole
 * design: a command sent but not recorded is lost work, while one recorded but
 * not sent is recoverable on the next drain.
 *
 * Delivery states:
 *
 *   queued → pending → sent → accepted   (the runner has it; the command is retired)
 *                        └──→ rejected   (retired with a reason, or queued again)
 *
 * `queued` rows are invisible to `pendingFor` on purpose: a queued run is held
 * by session/workspace/capacity contention and must not be delivered until a
 * promotion moves it back to `pending`.
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
import { createHash } from "node:crypto";
import type { CommandKind } from "@cc-web/protocol";
import { canonicalize, fingerprint } from "@cc-web/shared";

export type { CommandKind } from "@cc-web/protocol";

export type QueueSnapshot = { runnerId: string; workspaceId: string | undefined };

export const MAX_REQUEUES = 50;

export type EnqueueInput = {
  commandId: string;
  runnerId: string;
  kind: CommandKind;
  /**
   * The payload persisted to `command_outbox.payload`. Secrets such as profile
   * API keys are redacted here so on-disk state never holds cleartext material.
   */
  payload: unknown;
  /**
   * The secure payload persisted to `payload_secure`. When a profile is
   * present this is the cleartext run.start object after the scheduler sealed
   * it (§18.1); the dispatcher opens the envelope on every drain and sends the
   * result as the live WebSocket frame, while `payload` stays the redacted
   * copy. Rows written before the column existed carry NULL here, and the
   * dispatcher falls back to the redacted `payload` — the runner then has no
   * usable key and fails authentication rather than receiving a substituted
   * one.
   */
  payloadSecure?: unknown;
  issuedAt: string;
  expiresAt?: string;
  runId?: string;
  attemptId?: string;
  sessionId?: string;
  workspaceId?: string;
  deliveryState?: "pending" | "queued";
  queueSnapshot?: QueueSnapshot;
};

export type DeliveryState = "queued" | "pending" | "sent" | "accepted" | "rejected";

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
  /** The sealed payload the dispatcher opens for the live frame; undefined when none was stored. */
  payloadSecure: unknown | undefined;
  requeueCount: number;
  queueSnapshot: QueueSnapshot | undefined;
};

type Row = {
  command_id: string;
  runner_id: string;
  kind: string;
  payload: string;
  payload_secure: string | null;
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
  requeue_count: number;
  queue_snapshot: string | null;
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
    const deliveryState = input.deliveryState ?? "pending";
    const queueSnapshot =
      input.queueSnapshot === undefined
        ? null
        : JSON.stringify({
            runnerId: input.queueSnapshot.runnerId,
            workspaceId: input.queueSnapshot.workspaceId ?? null,
          });
    this.#db
      .query(
        `INSERT INTO command_outbox
           (command_id, runner_id, kind, payload, payload_secure, fingerprint, issued_at, expires_at,
            session_id, run_id, attempt_id, workspace_id,
            delivery_state, attempt_count, requeue_count, queue_snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      )
      .run(
        input.commandId,
        input.runnerId,
        input.kind,
        JSON.stringify(input.payload ?? null),
        input.payloadSecure === undefined ? null : JSON.stringify(input.payloadSecure ?? null),
        fingerprint,
        input.issuedAt,
        input.expiresAt ?? null,
        input.sessionId ?? null,
        input.runId ?? null,
        input.attemptId ?? null,
        input.workspaceId ?? null,
        deliveryState,
        queueSnapshot,
        Date.now(),
      );
  }

  /**
   * Commands this runner should receive now: `pending` and `sent`, minus anything
   * that has expired against `now`. `queued` rows are invisible on purpose — a
   * queued run is held by contention and must not be delivered until promoted.
   */
  pendingFor(runnerId: string, options: { now?: Date } = {}): OutboxCommand[] {
    const now = (options.now ?? new Date()).toISOString();

    const rows = this.#db
      .query(
        `SELECT * FROM command_outbox
          WHERE runner_id = ?
            AND delivery_state IN ('pending', 'sent')
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
    if (row.delivery_state === "queued") return;

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
    if (row.delivery_state === "queued") return;

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
    if (row.delivery_state === "queued") return;

    this.#db
      .query(
        `UPDATE command_outbox
            SET delivery_state = 'accepted', accepted_at = ?
          WHERE command_id = ?`,
      )
      .run(Date.now(), commandId);
  }

  markQueued(commandId: string): void {
    const row = this.#require(commandId);
    if (row.delivery_state !== "pending") return;
    this.#db
      .query("UPDATE command_outbox SET delivery_state = 'queued' WHERE command_id = ?")
      .run(commandId);
  }

  /**
   * Rewrite a command's persisted payload and fingerprint while queueing it
   * again, synchronously and in one step. Used when an admitted enqueue loses
   * the active_runs race and must become queued without a stale payload (e.g. a
   * queued run must never carry a frozen `resumeSessionId`): the fingerprint is
   * immutable per command id in meaning, so changing the payload also requires
   * changing the fingerprint that describes it. The caller precomputes the new
   * fingerprint before the await boundary so no yield occurs here.
   */
  replaceQueuedPayload(
    commandId: string,
    input: { payload: unknown; payloadSecure: unknown; fingerprint: string },
  ): void {
    const row = this.#require(commandId);
    if (row.delivery_state !== "pending") return;
    this.#db
      .query(
        `UPDATE command_outbox
            SET delivery_state = 'queued',
                payload = ?,
                payload_secure = ?,
                fingerprint = ?
          WHERE command_id = ?`,
      )
      .run(
        JSON.stringify(input.payload ?? null),
        input.payloadSecure === undefined ? null : JSON.stringify(input.payloadSecure ?? null),
        input.fingerprint,
        commandId,
      );
  }

  markPromoted(commandId: string): void {
    const row = this.#require(commandId);
    if (row.delivery_state !== "queued") return;
    this.#db
      .query(
        "UPDATE command_outbox SET delivery_state = 'pending', queue_snapshot = NULL WHERE command_id = ?",
      )
      .run(commandId);
  }

  requeue(commandId: string): "requeued" | "ceiling" | "not_rejected" {
    const row = this.#require(commandId);
    if (row.delivery_state !== "rejected") return "not_rejected";
    // `requeue_count > MAX_REQUEUES` is the ceiling (MAX_REQUEUES itself still requeues).
    if (row.requeue_count > MAX_REQUEUES) return "ceiling";

    const snapshot = row.queue_snapshot
      ? row.queue_snapshot
      : JSON.stringify({ runnerId: row.runner_id, workspaceId: row.workspace_id ?? null });

    // §"Resume semantics": a queued run must not carry a frozen
    // `resumeSessionId`. This is the path that starts from an **admitted**
    // command — so its payload does carry the field — and returns it to the
    // queue, where the runner must instead resolve the conversation as it
    // stands when the run starts. Stripping it here, not at promotion, is what
    // keeps the queue entry honest for its whole life in the queue.
    //
    // The payload the runner receives is `payload_secure` when one exists
    // (§18.1) and the redacted `payload` otherwise, so both move together or
    // the redaction would disagree with the live frame. The fingerprint is
    // computed from the redacted copy, exactly like `fingerprintOf`, and moves
    // with it in the same statement: a payload change with a stale fingerprint
    // makes the redelivery a `fingerprint_mismatch`, i.e. a command the runner
    // will refuse forever. A row that never carried the field is written back
    // unchanged, fingerprint included — rewriting an unrelated row would be
    // silent corruption of the outbox's immutability contract.
    const redacted = JSON.parse(row.payload) as unknown;
    const secure =
      row.payload_secure === null ? undefined : (JSON.parse(row.payload_secure) as unknown);
    const nextRedacted = withoutResume(redacted);
    const nextSecure = secure === undefined ? undefined : withoutResume(secure);
    const changed = nextRedacted !== undefined || nextSecure !== undefined;

    const payloadValue = nextRedacted ?? redacted;
    const secureValue = nextSecure ?? secure;
    const fingerprintValue = changed
      ? fingerprintOfSync({
          commandId,
          runnerId: row.runner_id,
          kind: row.kind as CommandKind,
          payload: payloadValue,
          issuedAt: row.issued_at,
        })
      : row.fingerprint;

    this.#db
      .query(
        `UPDATE command_outbox
            SET delivery_state = 'queued',
                requeue_count = requeue_count + 1,
                rejection_reason = NULL,
                queue_snapshot = ?,
                payload = ?,
                payload_secure = ?,
                fingerprint = ?
          WHERE command_id = ?`,
      )
      .run(
        snapshot,
        JSON.stringify(payloadValue ?? null),
        secureValue === undefined ? null : JSON.stringify(secureValue ?? null),
        fingerprintValue,
        commandId,
      );
    return "requeued";
  }

  queuedFor(runnerId: string): OutboxCommand[] {
    const rows = this.#db
      .query(
        `SELECT * FROM command_outbox
          WHERE runner_id = ?
            AND delivery_state = 'queued'
            AND kind = 'run.start'
          ORDER BY created_at ASC, command_id ASC`,
      )
      .all(runnerId) as Row[];
    return rows.map(toCommand);
  }

  queuedForSession(sessionId: string): OutboxCommand[] {
    const rows = this.#db
      .query(
        `SELECT * FROM command_outbox
          WHERE session_id = ?
            AND delivery_state = 'queued'
            AND kind = 'run.start'
          ORDER BY created_at ASC, command_id ASC`,
      )
      .all(sessionId) as Row[];
    return rows.map(toCommand);
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
  //
  // The fingerprint is computed from the redacted `payload`, not from
  // `payloadSecure`: two re-dispatches of the same logical command must share an
  // id even though the cleartext key travels alongside.
  return fingerprint({
    commandId: input.commandId,
    runnerId: input.runnerId,
    kind: input.kind,
    payload: input.payload ?? null,
  });
}

/**
 * `fingerprintOf` without the await.
 *
 * `fingerprint` is async because it uses Web Crypto, which is the only digest
 * API importable from the web bundle. Some transitions cannot yield: `requeue`
 * rewrites payload and fingerprint in one statement precisely so no reader and
 * no concurrent promote can observe a queued row that still means the old
 * thing. `createHash` over the same canonical form produces a byte-identical
 * digest — verified against the async path over unicode, null, undefined and
 * numeric edge cases — so the two are interchangeable, not merely similar.
 */
export function fingerprintOfSync(input: EnqueueInput): string {
  return createHash("sha256")
    .update(
      canonicalize({
        commandId: input.commandId,
        runnerId: input.runnerId,
        kind: input.kind,
        payload: input.payload ?? null,
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * The payload with `resumeSessionId` removed, or `undefined` when it was not
 * there to remove.
 *
 * Returning `undefined` for "nothing to do" is what lets `requeue` leave an
 * unaffected row's bytes untouched instead of round-tripping it through
 * `JSON.parse`/`JSON.stringify` for no reason.
 */
function withoutResume(payload: unknown): Record<string, unknown> | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (!("resumeSessionId" in record)) return undefined;
  const { resumeSessionId: _dropped, ...rest } = record;
  return rest;
}

function toCommand(row: Row): OutboxCommand {
  const queueSnapshot = row.queue_snapshot
    ? (() => {
        const parsed = JSON.parse(row.queue_snapshot) as {
          runnerId: string;
          workspaceId?: string | null;
        };
        return {
          runnerId: parsed.runnerId,
          workspaceId: parsed.workspaceId ?? undefined,
        };
      })()
    : undefined;
  return {
    commandId: row.command_id,
    runnerId: row.runner_id,
    kind: row.kind as CommandKind,
    payload: JSON.parse(row.payload) as unknown,
    payloadSecure:
      row.payload_secure === null ? undefined : (JSON.parse(row.payload_secure) as unknown),
    issuedAt: row.issued_at,
    expiresAt: row.expires_at ?? undefined,
    deliveryState: row.delivery_state as DeliveryState,
    attemptCount: row.attempt_count,
    attemptId: row.attempt_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    runId: row.run_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    rejectionReason: row.rejection_reason ?? undefined,
    requeueCount: row.requeue_count ?? 0,
    queueSnapshot,
  };
}
