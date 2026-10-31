/**
 * Dispatch on the live transport (§9.2, §14.3).
 *
 * The outbox knows *what* is undelivered and the gateway knows *who* may receive
 * it. This is the seam: it drains one runner's pending commands into that
 * runner's current socket, and nothing more.
 *
 * Three rules, all of them about ordering rather than delivery:
 *
 *  1. **Only `ready` receives work.** `connected` means the hello succeeded; it
 *     does not mean the server and the runner agree about what is running
 *     (§6.2). Sending there is how a run lands on state neither side can vouch
 *     for.
 *  2. **`sent` is not `accepted`.** A socket write can be lost after the write
 *     returns, so the command stays deliverable and the next drain offers it
 *     again under the same id (§12.2). The runner's inbox is what makes that
 *     harmless.
 *  3. **The frame is rebuilt from the row.** Nothing is kept in memory between
 *     drains, so a server restart mid-dispatch redelivers rather than forgets.
 */

import type { CommandOutbox, OutboxCommand } from "@cc-web/control-db";
import { PROTOCOL_VERSION, type RunnerCommand } from "@cc-web/protocol";
import type { CommandReceipt } from "../websocket/runner/runner-gateway.ts";

/** The subset of `RunnerGateway` used here; keeps the dispatcher testable. */
export type CommandSink = {
  sendCommand(
    runnerId: string,
    command: RunnerCommand,
  ): { ok: true } | { ok: false; reason: "offline" | "not_ready" | "revoked" };
};

export type DrainResult = {
  /** Commands handed to a socket. Not a receipt — see rule 2 above. */
  sent: number;
  /** Undelivered, because the runner could not take them yet. */
  skipped: number;
};

export type DispatcherOptions = {
  outbox: CommandOutbox;
  gateway: CommandSink;
  /**
   * Called when the runner rejects a `run.start` command. The server frees the
   * active_runs slot so the session is not stranded in `session_busy` (§9.4).
   * Not called for `run.cancel` rejections — the original run may still execute
   * (§14.2). The command id and rejection reason are passed for operator logging.
   */
  onRejectedStart?: (runId: string, commandId: string, reason: string) => void;
  now?: () => Date;
  /**
   * Opens the sealed `payloadSecure` column back to its cleartext value
   * (§18.1, P3-C Task 5b). When absent the stored value is used as-is. When it
   * returns `null` the redacted `payload` is used as a fallback so a tampered
   * or foreign-key row still produces a (keyless) frame rather than throwing.
   */
  openSecurePayload?: (stored: unknown) => unknown | null;
};

export class Dispatcher {
  readonly #outbox: CommandOutbox;
  readonly #gateway: CommandSink;
  readonly #onRejectedStart: DispatcherOptions["onRejectedStart"];
  readonly #now: () => Date;
  readonly #openSecurePayload: DispatcherOptions["openSecurePayload"];

  constructor(options: DispatcherOptions) {
    this.#outbox = options.outbox;
    this.#gateway = options.gateway;
    this.#onRejectedStart = options.onRejectedStart;
    this.#now = options.now ?? (() => new Date());
    this.#openSecurePayload = options.openSecurePayload;
  }

  /**
   * Offer everything pending for one runner, in the order it was enqueued.
   *
   * Ordering is by creation, not by kind: §9.6's control lane (cancel ahead of a
   * queued start) is a property of the runner's local dispatcher, which has the
   * command classes in hand. Reordering here would mean the server second-guessing
   * a queue it cannot see.
   */
  drain(runnerId: string): DrainResult {
    // Retire what can no longer be delivered before choosing what to send. An
    // expired command filtered out of the batch but left `pending` is work the
    // operator keeps waiting on and nothing ever resolves.
    this.#outbox.retireExpired(runnerId, this.#now());

    const pending = this.#outbox.pendingFor(runnerId, { now: this.#now() });
    if (pending.length === 0) return { sent: 0, skipped: 0 };

    // One check for the whole batch: the state cannot change between two
    // synchronous sends on the same socket, and re-checking per command would
    // only make a partially-drained batch look like a runner that went away.
    let sent = 0;
    const skipped = pending.length;

    for (const command of pending) {
      const result = this.#gateway.sendCommand(
        runnerId,
        toEnvelope(command, this.#openSecurePayload),
      );
      if (!result.ok) break;

      // Only now, and only for this command: a send that did not happen must not
      // advance the delivery state, or the retry counter would describe attempts
      // nobody made.
      this.#outbox.markSent(command.commandId);
      sent += 1;
    }

    return { sent, skipped: skipped - sent };
  }

  /**
   * Apply a receipt from a runner (§9.4).
   *
   * `accepted` means the inbox persisted the command, not that it ran. Both
   * answers retire the command from delivery, because either way re-offering it
   * would produce the same receipt again — the runner is not going to change its
   * mind about a command it already refused.
   *
   * Throws for an unknown command id: that is a protocol error, and the gateway
   * turns it into an error frame. Recording it would create delivery state for a
   * command nothing enqueued.
   */
  handleReceipt(_runnerId: string, receipt: CommandReceipt): void {
    if (receipt.accepted) {
      this.#outbox.markAccepted(receipt.commandId, receipt.attemptId);
      return;
    }

    // Look up the row before retiring it: the caller needs to know whether the
    // rejected command was a `run.start` (slot must be freed) or a `run.cancel`
    // (the original run may still execute — §14.2).
    const row = this.#outbox.get(receipt.commandId);
    this.#outbox.markRejected(receipt.commandId, receipt.reason ?? "rejected_by_runner");

    if (row?.kind === "run.start" && row.runId !== undefined) {
      this.#onRejectedStart?.(row.runId, receipt.commandId, receipt.reason ?? "rejected_by_runner");
    }
  }
}

/**
 * §9.1's envelope, rebuilt from the stored row.
 *
 * `openSecurePayload` decrypts the sealed `payloadSecure` column back to its
 * cleartext value (§18.1, P3-C Task 5b). When absent the stored value is used
 * as-is; when it returns `null` the redacted `payload` is the fallback so a
 * tampered or foreign-key row still yields a (keyless) frame instead of
 * throwing.
 */
export function toEnvelope(
  command: OutboxCommand,
  openSecurePayload?: (stored: unknown) => unknown | null,
): RunnerCommand {
  let payload = command.payloadSecure ?? command.payload;
  if (command.payloadSecure !== undefined && openSecurePayload !== undefined) {
    const opened = openSecurePayload(command.payloadSecure);
    payload = opened === null ? command.payload : opened;
  }

  const envelope: RunnerCommand = {
    protocolVersion: PROTOCOL_VERSION,
    commandId: command.commandId,
    runnerId: command.runnerId,
    kind: command.kind,
    issuedAt: command.issuedAt,
    payload,
  };

  // Absent fields are omitted rather than sent as `null`: the runner validates
  // the envelope, and a key that is present but null reads as "explicitly none".
  if (command.sessionId !== undefined) envelope.sessionId = command.sessionId;
  if (command.runId !== undefined) envelope.runId = command.runId;
  if (command.attemptId !== undefined) envelope.attemptId = command.attemptId;
  if (command.workspaceId !== undefined) envelope.workspaceId = command.workspaceId;
  if (command.expiresAt !== undefined) envelope.expiresAt = command.expiresAt;

  return envelope;
}
