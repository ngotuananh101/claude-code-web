/**
 * The browser's one WebSocket (§16.2: a singleton service, never per-
 * component). Components subscribe to frames and state; nobody else touches
 * the socket.
 *
 * Reconnect is bounded-backoff and unconditional: the control server is the
 * app's whole reason to exist, so a dropped socket is a state to show, not a
 * decision to make. What reconnect does NOT do is resubscribe — the session
 * store owns that, because only it knows which session to rewind and from
 * which offset (its own watermark, §12.5).
 */

export type SocketState = "connecting" | "live" | "closed";

type FrameListener = (frame: Record<string, unknown>) => void;

const MAX_BACKOFF_MS = 10_000;

class SocketService {
  #ws: WebSocket | null = null;
  #frameListeners = new Set<FrameListener>();
  #stateListeners = new Set<(state: SocketState) => void>();
  #reopenListeners = new Set<() => void>();
  #attempt = 0;
  #state: SocketState = "connecting";

  get state(): SocketState {
    return this.#state;
  }

  connect(): void {
    this.#setState("connecting");
    // Same-origin through the vite dev proxy in development, the control
    // server's own origin in production; the HttpOnly cookie rides along,
    // which is the whole authentication (§19.1).
    const ws = new WebSocket(`${location.origin}/ws/browser`);
    this.#ws = ws;

    ws.addEventListener("open", () => {
      this.#attempt = 0;
      this.#setState("live");
      for (const listener of this.#reopenListeners) listener();
    });
    ws.addEventListener("message", (event) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        // A frame we cannot parse is dropped, not fatal — the journal's
        // truth lives server-side and the next replay repairs any doubt.
        return;
      }
      for (const listener of this.#frameListeners) listener(frame);
    });
    ws.addEventListener("close", () => {
      if (this.#ws !== ws) return; // a newer socket already took over
      this.#ws = null;
      this.#setState("closed");
      const delay = Math.min(1000 * 2 ** this.#attempt, MAX_BACKOFF_MS);
      this.#attempt += 1;
      setTimeout(() => this.connect(), delay);
    });
  }

  onFrame(listener: FrameListener): () => void {
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  }

  onState(listener: (state: SocketState) => void): () => void {
    listener(this.#state);
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  /** Fires after every successful (re)connect — the store's cue to rewind. */
  onReopen(listener: () => void): () => void {
    this.#reopenListeners.add(listener);
    return () => this.#reopenListeners.delete(listener);
  }

  send(frame: unknown): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(frame));
    }
    // A send into a closed socket is dropped, not queued: whatever the frame
    // asked for is re-asked on reopen (the store resubscribes from its
    // watermark), and a queue would replay stale intent in stale order.
  }

  #setState(state: SocketState): void {
    this.#state = state;
    for (const listener of this.#stateListeners) listener(state);
  }
}

export const socket = new SocketService();
