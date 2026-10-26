/**
 * The outbox → control server sender (§12.2).
 *
 * `persist → send → ACK` in that order, and never a shortcut: rows are already
 * durable when the pump sees them (the executor commits before counting a
 * sequence), a send is only an attempt, and only an ACK retires a row. A lost
 * ACK arrives later as a duplicate the server deduplicates; a lost send arrives
 * as a pending row the next flush resends.
 *
 * The pump knows nothing about sockets. It is handed a `send` that answers
 * boolean — the daemon wires it to the reconnect loop's `sendFrame`, whose
 * "ready link or false" guard is what keeps the pump from writing into a dead
 * socket during a reconnect window.
 */

import type { Database } from "bun:sqlite";
import {
  type EventBatchFrame,
  type EventType,
  PROTOCOL_VERSION,
  type RunnerEvent,
} from "@cc-web/protocol";
import { ackUpTo, type PendingEvent, pendingEventAttempts, pendingEvents } from "@cc-web/runner-db";

export type EventPumpOptions = {
  db: Database;
  runnerId: string;
  bootId: string;
  /** Hand a frame to the transport; false means it was not carried. */
  send: (frame: EventBatchFrame) => boolean;
  /**
   * Defer the retry of a refused send. Defaults to `setTimeout`; the seam
   * exists so a test can drive the retry instead of sleeping through it.
   */
  schedule?: (fn: () => void, ms: number) => unknown;
};

export class EventPump {
  /**
   * How long to wait before retrying a refused frame (§12.6).
   *
   * Long enough to be a backoff rather than a spin — a refused frame that is
   * retried immediately is a busy loop against a link that is down — and short
   * enough that a recovering link is not held up by it. Reconnection itself
   * flushes too; this timer is only what covers the quiet run.
   */
  static readonly LINGER_MS = 50;

  readonly #db: Database;
  readonly #runnerId: string;
  readonly #bootId: string;
  readonly #send: (frame: EventBatchFrame) => boolean;
  readonly #schedule: (fn: () => void, ms: number) => unknown;
  #retryArmed = false;
  #stopped = false;

  constructor(options: EventPumpOptions) {
    this.#db = options.db;
    this.#runnerId = options.runnerId;
    this.#bootId = options.bootId;
    this.#send = options.send;
    this.#schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  }

  /** Events per frame (§12.6). Bounded frames, never one row per socket write
   * without a ceiling — a full transcript in one allocation is how a socket
   * dies of memory rather than of bandwidth. */
  static readonly BATCH_LIMIT = 64;

  /**
   * Bytes per frame, measured over the serialized frame — the same bytes Bun
   * buffers and compares against its own `backpressureLimit` (16 MiB default).
   *
   * The measured worst case at the event ceiling is 558 KiB (64 events each
   * carrying an 8 KiB tool input). 256 KiB keeps a frame far below Bun's limit
   * while staying above the realistic 46–53 KiB frame, so ordinary traffic
   * still fills by count and pays for no extra frames.
   */
  static readonly BATCH_BYTES_LIMIT = 256 * 1024;

  /** Send one bounded batch for every attempt with pending rows. */
  flush(): void {
    if (this.#stopped) return;
    for (const attemptId of pendingEventAttempts(this.#db)) {
      // A refused send means the link is down; every later attempt would be
      // refused too, and the rows stay pending for the next ready flush.
      if (!this.#flushAttempt(attemptId)) return;
    }
  }

  /**
   * Apply a server ACK, then keep pumping that attempt if rows remain — the
   * ack of one bounded batch is the trigger to send the next.
   */
  handleAck(ack: { attemptId: string; through: number }): void {
    if (this.#stopped) return;
    ackUpTo(this.#db, { attemptId: ack.attemptId, sequence: ack.through });
    this.#flushAttempt(ack.attemptId);
  }

  /**
   * Stop pumping. Nothing already in the outbox is lost — it is durable, and a
   * restarted process resends it — but the retry timer must not outlive the
   * daemon and turn a clean shutdown into a pending-handle exit.
   */
  stop(): void {
    this.#stopped = true;
    this.#retryArmed = false;
  }

  /**
   * A refused frame is the pump's problem to retry, not the next event's.
   *
   * One timer per pump, not one per flush: an outage produces a refusal on
   * every flush, and a timer per refusal would grow the queue with the event
   * rate — the opposite of backpressure. The flag is cleared when the timer
   * fires, so a refusal after the retry arms a new one.
   */
  #armRetry(): void {
    if (this.#retryArmed || this.#stopped) return;
    this.#retryArmed = true;
    this.#schedule(() => {
      this.#retryArmed = false;
      this.flush();
    }, EventPump.LINGER_MS);
  }

  #flushAttempt(attemptId: string): boolean {
    const rows = this.#selectBatch(attemptId);
    if (rows.length === 0) return true;
    const carried = this.#send({
      type: "events",
      events: rows.map((row) => this.#toWireEvent(row)),
    });
    if (!carried) this.#armRetry();
    return carried;
  }

  /**
   * The rows for one frame: at most `BATCH_LIMIT` events and at most
   * `BATCH_BYTES_LIMIT` serialized bytes, always at least one row.
   *
   * Sizing is done on the serialized wire event because that is what the
   * transport buffers; counting payload bytes would under-count the measured
   * 359 B/event of envelope by roughly 30% on a delta-heavy stream.
   */
  #selectBatch(attemptId: string): PendingEvent[] {
    const rows = pendingEvents(this.#db, attemptId, { limit: EventPump.BATCH_LIMIT });
    const selected: PendingEvent[] = [];
    let bytes = 0;

    for (const row of rows) {
      const event = this.#toWireEvent(row);
      const size = JSON.stringify(event).length;
      // The first row is always taken, however large: a single oversized event
      // is bounded by the per-event caps elsewhere in the pipeline, and
      // refusing it here would be the silent drop §12.6 forbids.
      if (selected.length > 0 && bytes + size > EventPump.BATCH_BYTES_LIMIT) break;
      selected.push(row);
      bytes += size;
    }

    return selected;
  }

  /**
   * The wire identity is per-process, not per-row: the rows carry the attempt's
   * facts, and the protocol version, runner id and boot id come from this
   * process, which is what the server's identity check compares against.
   */
  #toWireEvent(row: PendingEvent): RunnerEvent {
    return {
      protocolVersion: PROTOCOL_VERSION,
      eventId: row.eventId,
      runnerId: this.#runnerId,
      bootId: this.#bootId,
      sessionId: row.sessionId,
      runId: row.runId,
      attemptId: row.attemptId,
      localSequence: row.localSequence,
      occurredAt: row.occurredAt,
      // Written by our own executor, so the type is in-family by construction.
      type: row.type as EventType,
      payload: row.payload,
    };
  }
}
