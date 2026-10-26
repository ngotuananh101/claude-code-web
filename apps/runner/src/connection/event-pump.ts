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
import {
  ackUpTo,
  type PendingEvent,
  pendingEventAttempts,
  pendingEvents,
  spoolDepth,
} from "@cc-web/runner-db";

/** How deep one attempt's unacknowledged spool is, at the moment it was read. */
export type SpoolReport = {
  attemptId: string;
  events: number;
  bytes: number;
};

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
  /**
   * Cancel a scheduled retry, paired with `schedule`. Defaults to
   * `clearTimeout`. The seam exists because a scheduled retry is a live timer:
   * one left behind keeps the event loop alive, so `stop()` has to cancel it
   * rather than only mark itself stopped.
   */
  unschedule?: (handle: unknown) => void;
  /**
   * The spool crossed the warning threshold (§12.6). A signal, not an action:
   * the pump reports and keeps pumping, and whoever owns the run decides
   * whether the operator should hear about it.
   */
  onSpoolWarning?: (report: SpoolReport) => void;
  /**
   * The spool crossed the critical threshold (§12.6). The pump still reports
   * rather than acts — it has no way to stop a run and no sequence to journal a
   * failure record at — but the expectation is that the receiver stops the run.
   */
  onSpoolCritical?: (report: SpoolReport) => void;
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
  readonly #unschedule: (handle: unknown) => void;
  readonly #onSpoolWarning: ((report: SpoolReport) => void) | undefined;
  readonly #onSpoolCritical: ((report: SpoolReport) => void) | undefined;
  #retryArmed = false;
  #stopped = false;
  /** The live retry timer, so `stop()` can cancel it rather than orphan it. */
  #retryTimer: unknown;
  /** Attempts currently believed to be over the warning depth. */
  readonly #warned = new Set<string>();
  /** Attempts currently believed to be over the critical depth. */
  readonly #critical = new Set<string>();

  constructor(options: EventPumpOptions) {
    this.#db = options.db;
    this.#runnerId = options.runnerId;
    this.#bootId = options.bootId;
    this.#send = options.send;
    this.#schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.#unschedule =
      options.unschedule ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#onSpoolWarning = options.onSpoolWarning;
    this.#onSpoolCritical = options.onSpoolCritical;
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

  /**
   * The offline-spool warning threshold (§12.6): 5,000 unacked events or 16 MiB
   * of unacked payload, whichever is reached first.
   *
   * Both parts are checked because either alone misses a real case — a long
   * quiet stream of tiny deltas is many events by few bytes, and a handful of
   * large tool results is many bytes by few events.
   */
  static readonly SPOOL_WARNING = { events: 5_000, bytes: 16 * 1024 * 1024 };

  /**
   * The offline-spool critical threshold (§12.6): 25,000 unacked events or
   * 64 MiB of unacked payload. Here the run is to be stopped and a minimal
   * failure record written from a reserved budget, rather than silently
   * dropping mandatory events and reporting the run as a success.
   */
  static readonly SPOOL_CRITICAL = { events: 25_000, bytes: 64 * 1024 * 1024 };

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
    // Marking stopped is not enough: a timer armed before the stop is still
    // live, and a live timer keeps the event loop alive past the point the
    // daemon closed its database. Cancel it explicitly.
    if (this.#retryTimer !== undefined) {
      this.#unschedule(this.#retryTimer);
      this.#retryTimer = undefined;
    }
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
    this.#retryTimer = this.#schedule(() => {
      this.#retryTimer = undefined;
      this.#retryArmed = false;
      this.flush();
    }, EventPump.LINGER_MS);
  }

  #flushAttempt(attemptId: string): boolean {
    // Depth is checked before anything is sent, so a drop back below a
    // threshold re-arms it even on a flush that has nothing left to send.
    this.#reportSpoolDepth(attemptId);

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
   * Report a spool-depth crossing to the controller (§12.6), at most once per
   * crossing per attempt.
   *
   * The depth is read as one aggregate rather than derived from the batch: the
   * batch is what a frame carries, and the threshold is about the attempt's
   * whole backlog, of which a bounded frame may be a small part.
   *
   * Nothing here writes, deletes or stops. The pump holds no sequence and owns
   * no run, so the only thing it can honestly do is say how deep the spool got
   * and let the controller — which does own both — decide. A warning is
   * suppressed while the critical threshold is met, because "the spool is
   * getting deep" is noise once the answer is to stop the run.
   */
  #reportSpoolDepth(attemptId: string): void {
    const { events, bytes } = spoolDepth(this.#db, attemptId);
    const overCritical =
      events >= EventPump.SPOOL_CRITICAL.events || bytes >= EventPump.SPOOL_CRITICAL.bytes;
    const overWarning =
      events >= EventPump.SPOOL_WARNING.events || bytes >= EventPump.SPOOL_WARNING.bytes;

    if (!overCritical) this.#critical.delete(attemptId);
    if (!overWarning) this.#warned.delete(attemptId);

    if (overCritical) {
      if (this.#critical.has(attemptId)) return;
      this.#critical.add(attemptId);
      this.#warned.delete(attemptId);
      this.#onSpoolCritical?.({ attemptId, events, bytes });
      return;
    }

    if (!overWarning || this.#warned.has(attemptId)) return;
    this.#warned.add(attemptId);
    this.#onSpoolWarning?.({ attemptId, events, bytes });
  }

  /**
   * The rows for one frame: at most `BATCH_LIMIT` events and at most
   * `BATCH_BYTES_LIMIT` serialized bytes, always at least one row.
   *
   * Sizing is done in UTF-8 bytes over the framed batch, because that is what
   * the transport buffers. Two things make this more than a nicety: the content
   * is largely Vietnamese, so `JSON.stringify(...).length` (UTF-16 code units)
   * under-counts the wire by ~1.3×, and the frame envelope
   * (`{"type":"events","events":[…]}`) is itself ~24 B the code units do not see.
   * Counting payload bytes instead would miss the measured 359 B/event envelope.
   */
  #selectBatch(attemptId: string): PendingEvent[] {
    const rows = pendingEvents(this.#db, attemptId, { limit: EventPump.BATCH_LIMIT });
    const selected: PendingEvent[] = [];
    let bytes = 0;

    for (const row of rows) {
      const event = this.#toWireEvent(row);
      // The separator plus the event, so the count matches the comma-joined
      // array the frame actually carries.
      const size = Buffer.byteLength((selected.length === 0 ? "" : ",") + JSON.stringify(event));
      // The first row is always taken, however large: the per-event byte cap
      // (§12.6, enforced at append time in the executor) keeps a single event
      // under the transport ceiling, so it is always deliverable on its own
      // frame. Refusing it would be the silent drop §12.6 forbids.
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
