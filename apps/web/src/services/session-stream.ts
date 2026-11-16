import {
  type BrowserReplayEvent,
  type HistoryTurn,
  isConversationReset,
  isThinkingTokenEstimate,
  type SessionEventsFrame,
  type SessionHistoryFrame,
  type SessionResyncFrame,
} from "@cc-web/protocol";
import { validSessionHistory } from "./history-validation.ts";

/**
 * The client half of §12.5: how a browser absorbs replay frames into one
 * truthful transcript.
 *
 * The rules the whole interface depends on, decided here and nowhere in a
 * component:
 *
 * - `sessionSequence` is the only order the client reasons about. Arrival
 *   order, frame grouping and attempt ids are transport facts, not transcript
 *   facts.
 * - The client's own watermark (`through` — the highest contiguous sequence
 *   it holds) decides what is new. Anything at or below it is a duplicate the
 *   at-least-once protocol will keep producing.
 * - A hole is repaired, never papered over: the client resubscribes from its
 *   own watermark so the server re-serves the missing range into the dedup.
 * - `resync_required` means retention deleted history the client was trusting
 *   (§12.5): the transcript restarts at the earliest surviving event, and the
 *   interface shows an explicit repair state until continuity returns.
 *
 * The machine is pure. It never opens a socket; `send` is injected, which is
 * what lets the socket be a singleton service while this logic stays unit-
 * tested with bun test.
 */

export type SubscribeFrame = {
  type: "subscribe";
  sessionId: string;
  afterSessionSequence: number;
  projection: "journal";
  history?: true;
  requestId?: string;
};

export type SessionStreamState = {
  /** Highest contiguous covered session sequence (raw events or projected ranges). */
  through: number;
  /** Accepted events; journal projection omits non-content progress telemetry. */
  events: BrowserReplayEvent[];
  /** Current conversation's render projection, starting at its latest reset. */
  journalEvents: BrowserReplayEvent[];
  historyTurns: HistoryTurn[];
  historyBefore: number | null;
  historyHasMore: boolean;
  resetSequence: number;
  historyContext: BrowserReplayEvent[];
  bootstrapped: boolean;
  /** Live-ness of the last frame seen; null before the first one. */
  live: boolean | null;
  /** Retention deleted this client's history and the rewind is not done yet. */
  needsResync: boolean;
};

export type SessionStreamOptions = {
  sessionId: string;
  send: (frame: SubscribeFrame) => void;
  historyRequestId?: string;
};

export function createSessionStream(options: SessionStreamOptions): {
  apply: (frame: SessionEventsFrame | SessionResyncFrame | SessionHistoryFrame) => boolean;
  state: () => SessionStreamState;
} {
  const events: BrowserReplayEvent[] = [];
  const journalEvents: BrowserReplayEvent[] = [];
  let historyTurns: HistoryTurn[] = [];
  let historyBefore: number | null = null;
  let historyHasMore = false;
  let resetSequence = 0;
  let historyContext: BrowserReplayEvent[] = [];
  let bootstrapped = false;
  let through = 0;
  let live: boolean | null = null;
  let needsResync = false;
  // One resubscribe in flight. Without this, every out-of-order frame that
  // arrives while the first repair is pending would queue another subscribe,
  // and the server would chain replays to a client that only needs one.
  let awaitingReplay = false;

  function subscribe(after: number): void {
    awaitingReplay = true;
    options.send({
      type: "subscribe",
      sessionId: options.sessionId,
      afterSessionSequence: after,
      projection: "journal",
    });
  }

  function apply(frame: SessionEventsFrame | SessionResyncFrame | SessionHistoryFrame): boolean {
    if (frame.sessionId !== options.sessionId) return false;
    if (frame.type === "session.history") {
      if (!validSessionHistory(frame)) return false;
      if (frame.bootstrap) {
        if (bootstrapped || frame.watermark < through) return false;
        historyTurns = frame.turns;
        through = frame.watermark;
        events.length = 0;
        journalEvents.length = 0;
        resetSequence = frame.resetSequence;
        historyContext = frame.context;
        bootstrapped = true;
        awaitingReplay = false;
        needsResync = false;
      } else {
        if (
          !bootstrapped ||
          frame.resetSequence !== resetSequence ||
          frame.turns.some((turn) => historyBefore === null || turn.cursor >= historyBefore)
        )
          return false;
        historyTurns = [...frame.turns, ...historyTurns];
      }
      historyBefore = frame.before;
      historyHasMore = frame.hasMore;
      return true;
    }
    if (frame.type === "session.resync_required") {
      // Everything the client holds is outside the journal now. fromSequence
      // is the earliest surviving event; subscribing from through = from - 1
      // has the server serve that boundary event too.
      // Retention cannot be repaired by silently retaining old turn snapshots.
      const paged = bootstrapped || options.historyRequestId !== undefined;
      historyTurns = [];
      historyBefore = null;
      historyHasMore = false;
      historyContext = [];
      resetSequence = 0;
      bootstrapped = false;
      events.length = 0;
      journalEvents.length = 0;
      through = frame.fromSequence - 1;
      needsResync = true;
      if (paged) {
        awaitingReplay = true;
        options.send({
          type: "subscribe",
          sessionId: options.sessionId,
          afterSessionSequence: through,
          projection: "journal",
          history: true,
          ...(options.historyRequestId === undefined
            ? {}
            : { requestId: options.historyRequestId }),
        });
      } else subscribe(through);
      return true;
    }

    if (frame.projection === "journal") {
      // Validate the entire range before changing continuity or appending any
      // content. Only this negotiated projection may certify omitted sequences.
      let previous = frame.fromSequence - 1;
      const valid =
        Number.isSafeInteger(frame.fromSequence) &&
        frame.fromSequence > 0 &&
        Number.isSafeInteger(frame.through) &&
        frame.through >= 0 &&
        frame.fromSequence <= frame.through + 1 &&
        frame.events.every((event) => {
          const seq = event.sessionSequence;
          const ordered = Number.isSafeInteger(seq) && seq > previous && seq <= frame.through;
          previous = seq;
          return ordered && !isThinkingTokenEstimate(event);
        });
      if (!valid || frame.fromSequence > through + 1) {
        if (!awaitingReplay) subscribe(through);
        return false;
      }
      let changed = live !== frame.live;
      live = frame.live;
      if (frame.through <= through) return changed;
      for (const event of frame.events) {
        if (event.sessionSequence > through) {
          events.push(event);
          resetHistory(event);
          journalEvents.push(event);
        }
      }
      through = frame.through;
      needsResync = false;
      awaitingReplay = false;
      changed = true;
      return changed;
    }

    let changed = live !== frame.live;
    live = frame.live;
    for (const event of frame.events) {
      if (event.sessionSequence <= through) continue;
      if (event.sessionSequence === through + 1) {
        events.push(event);
        // Progress estimates do not alter chat or subagent content. Keep them
        // in the complete journal and advance continuity before projecting.
        resetHistory(event);
        if (!isThinkingTokenEstimate(event)) journalEvents.push(event);
        changed = true;
        through = event.sessionSequence;
        needsResync = false;
        awaitingReplay = false;
        continue;
      }
      // A hole: hold what we have, resubscribe from the watermark, and let
      // the re-replay re-serve the rest of this batch into the dedup.
      if (!awaitingReplay) subscribe(through);
      break;
    }
    return changed;
  }

  function resetHistory(event: BrowserReplayEvent): void {
    if (!isConversationReset(event)) return;
    journalEvents.length = 0;
    historyTurns = [];
    historyBefore = null;
    historyHasMore = false;
    resetSequence = event.sessionSequence;
    historyContext = [event];
  }

  function state(): SessionStreamState {
    return {
      through,
      events,
      journalEvents,
      live,
      needsResync,
      historyTurns,
      historyBefore,
      historyHasMore,
      resetSequence,
      historyContext,
      bootstrapped,
    };
  }

  return { apply, state };
}
