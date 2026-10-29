import type { BrowserReplayEvent } from "@cc-web/protocol";
import { reactive } from "vue";
import {
  createSessionStream,
  type SessionStreamState,
  type SubscribeFrame,
} from "../services/session-stream.ts";
import { type SocketState, socket } from "../services/socket.ts";

/**
 * The one store (§16.2), a reactive singleton: the session list for the rail,
 * the active session's stream state for the journal, and the connection
 * state for the chip. Pinia arrives when a second store proves necessary —
 * the API shape here is the one a Pinia store would expose.
 *
 * Frames reach the stream machine through this module, and every machine
 * mutation is mirrored into the reactive copy below — the machine mutates its
 * own arrays in place, which Vue's proxies would not see.
 */

export type SessionSummary = {
  sessionId: string;
  watermark: number;
  eventCount: number;
  lastEventType: string | null;
  lastIngestedAt: number;
  live: boolean;
  /** The session's pin (§2.3, ADR-006); null for a pre-pin session. */
  runnerId: string | null;
  workspaceId: string | null;
  /** The SDK session id to resume (§10.4), if known. */
  sdkSessionId: string | null;
};

type SessionsStore = {
  loaded: boolean;
  sessions: SessionSummary[];
  activeId: string | null;
  connection: SocketState;
  /** The active session's stream, null before a session is opened. */
  stream: SessionStreamState | null;
  /** The signed-in account's name (the rail footer), null until /api/me. */
  account: string | null;
};

export const sessions = reactive<SessionsStore>({
  loaded: false,
  sessions: [],
  activeId: null,
  connection: "closed",
  stream: null,
  account: null,
});

let machine: ReturnType<typeof createSessionStream> | null = null;
let unsubscribeFrames: (() => void) | null = null;

/** Reads the owner's session list. False means the cookie is no good. */
export async function loadSessions(): Promise<boolean> {
  const response = await fetch("/api/sessions");
  if (response.status === 401) return false;
  if (!response.ok) return sessions.loaded; // a hiccup keeps what we had
  const body = (await response.json()) as { sessions: SessionSummary[] };
  sessions.sessions = body.sessions;
  sessions.loaded = true;
  return true;
}

/**
 * Reads the signed-in account's name (GET /api/me). The footer must not
 * hardcode it — the operator seeds whatever username they chose. A failure
 * keeps whatever we had: the name is cosmetic, not an auth signal.
 */
export async function loadAccount(): Promise<void> {
  const response = await fetch("/api/me");
  if (!response.ok) return;
  sessions.account = ((await response.json()) as { username: string }).username;
}

/**
 * Subscribe to a session's journal, resuming from the watermark this client
 * already holds (§12.5) — reopening a session the machine was following
 * mid-stream costs only the events past `through`.
 */
export function openSession(sessionId: string): void {
  unsubscribeFrames?.();
  sessions.activeId = sessionId;
  machine = createSessionStream({
    sessionId,
    send: (frame: SubscribeFrame) => socket.send(frame),
  });
  sessions.stream = machine.state();

  unsubscribeFrames = socket.onFrame((frame) => {
    if (frame.type !== "session.events" && frame.type !== "session.resync_required") return;
    machine?.apply(frame as Parameters<typeof machine.apply>[0]);
    mirror();
  });

  socket.send({ type: "subscribe", sessionId, afterSessionSequence: sessions.stream.through });
}

/** Detaches from the active session without touching the socket. */
export function closeSession(): void {
  unsubscribeFrames?.();
  unsubscribeFrames = null;
  machine = null;
  sessions.activeId = null;
  sessions.stream = null;
}

function mirror(): void {
  // A fresh events array per frame, not just a fresh stream object: the
  // machine mutates its array in place, and Vue's component props compare is
  // shallow — a reused reference would leave the journal on its first (empty)
  // render no matter what arrived.
  if (machine !== null)
    sessions.stream = { ...machine.state(), events: [...machine.state().events] };
}

/**
 * Whether the active session shows its live flag. Two sources, and neither
 * alone is enough: the listing's `live` is the server's truth about "a run is
 * in flight" but only refreshes with the next listing read, while the
 * stream's frame-level flag is instant yet always false across a replay —
 * an in-flight run can sit quiet long enough for its last frame to be a
 * replay batch. Either signal saying "live" is live.
 */
export function resolveSessionLive(
  listingLive: boolean | undefined,
  streamLive: boolean | null,
): boolean {
  return listingLive === true || streamLive === true;
}

/** Wires the store to the socket singleton once, at app start. */
export function startStore(): void {
  socket.onState((state) => {
    sessions.connection = state;
  });
  // After any reopen the subscription is gone with the old socket: rewind to
  // the watermark we still hold, and let the machine's dedup absorb the
  // replay overlap (§12.5).
  socket.onReopen(() => {
    if (sessions.activeId !== null) {
      socket.send({
        type: "subscribe",
        sessionId: sessions.activeId,
        afterSessionSequence: sessions.stream?.through ?? 0,
      });
    }
    void loadSessions();
  });
  // Intentionally NOT connecting here: the socket stays closed until the
  // authenticated shell opts in via connectSocket() (§16.2).
}

/** Opt in to the WebSocket now that the shell is authenticated. */
export function connectSocket(): void {
  socket.connect();
}

/** Opt out: cancel reconnects, close the live socket, mark closed. */
export function disconnectSocket(): void {
  socket.disconnect();
}

export type { BrowserReplayEvent };
