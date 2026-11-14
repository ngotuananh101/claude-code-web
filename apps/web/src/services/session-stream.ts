import type { BrowserReplayEvent, SessionEventsFrame, SessionResyncFrame } from "@cc-web/protocol";

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
};

export type SessionStreamState = {
  /** Highest contiguous session_sequence held. Next event must be through+1. */
  through: number;
  /** Complete accepted journal, including progress telemetry. */
  events: BrowserReplayEvent[];
  /** Render projection: excludes only non-content thinking-token estimates. */
  journalEvents: BrowserReplayEvent[];
  /** Live-ness of the last frame seen; null before the first one. */
  live: boolean | null;
  /** Retention deleted this client's history and the rewind is not done yet. */
  needsResync: boolean;
};

export type SessionStreamOptions = {
  sessionId: string;
  send: (frame: SubscribeFrame) => void;
};

function isThinkingTokenEstimate(event: BrowserReplayEvent): boolean {
  if (event.type !== "run.status" || typeof event.payload !== "object" || event.payload === null)
    return false;
  const payload = event.payload as Record<string, unknown>;
  return payload["type"] === "system" && payload["subtype"] === "thinking_tokens";
}

export function createSessionStream(options: SessionStreamOptions): {
  apply: (frame: SessionEventsFrame | SessionResyncFrame) => boolean;
  state: () => SessionStreamState;
} {
  const events: BrowserReplayEvent[] = [];
  const journalEvents: BrowserReplayEvent[] = [];
  let through = 0;
  let live: boolean | null = null;
  let needsResync = false;
  // One resubscribe in flight. Without this, every out-of-order frame that
  // arrives while the first repair is pending would queue another subscribe,
  // and the server would chain replays to a client that only needs one.
  let awaitingReplay = false;

  function subscribe(after: number): void {
    awaitingReplay = true;
    options.send({ type: "subscribe", sessionId: options.sessionId, afterSessionSequence: after });
  }

  function apply(frame: SessionEventsFrame | SessionResyncFrame): boolean {
    if (frame.sessionId !== options.sessionId) return false;
    if (frame.type === "session.resync_required") {
      // Everything the client holds is outside the journal now. fromSequence
      // is the earliest surviving event; subscribing from through = from - 1
      // has the server serve that boundary event too.
      events.length = 0;
      journalEvents.length = 0;
      through = frame.fromSequence - 1;
      needsResync = true;
      subscribe(through);
      return true;
    }

    let changed = live !== frame.live;
    live = frame.live;
    for (const event of frame.events) {
      if (event.sessionSequence <= through) continue;
      if (event.sessionSequence === through + 1) {
        events.push(event);
        // Progress estimates do not alter chat or subagent content. Keep them
        // in the complete journal and advance continuity before projecting.
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

  function state(): SessionStreamState {
    return { through, events, journalEvents, live, needsResync };
  }

  return { apply, state };
}
