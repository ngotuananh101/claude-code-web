import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { socket } from "./socket.ts";

/**
 * The socket service is the singleton WebSocket (§16.2). Its contract under
 * test here is the explicit lifecycle: the app opts in with connect() and, once
 * it opts out with disconnect(), the service must not reconnect on any close.
 *
 * Tests drive the WebSocket.open/close callbacks directly so the reconnect
 * path's setTimeout is exercised deterministically.
 */

const originalWebSocket = globalThis.WebSocket;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalLocation = (globalThis as Record<string, unknown>).location;

// Stub the DOM globals the service touches; restored per-test so the stub is
// present for every test (a per-test restore to `undefined` would wipe it).
const locationStub = { origin: "http://localhost:5173" };

/**
 * A controllable timer: callbacks are queued rather than fired, so a test can
 * assert on schedule intent and let disconnect()'s clearTimeout actually
 * remove a pending reconnect. Advance with `flushPending()`.
 */
function installFakeTimers(): {
  scheduled: Set<() => void>;
  flushPending: () => void;
} {
  const scheduled: Set<() => void> = new Set();

  globalThis.setTimeout = ((fn: () => void, _ms: number) => {
    scheduled.add(fn);
    return fn as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout;

  globalThis.clearTimeout = ((id: NodeJS.Timeout) => {
    scheduled.delete(id as unknown as () => void);
  }) as unknown as typeof clearTimeout;

  return {
    scheduled,
    flushPending: () => {
      const copy = [...scheduled];
      scheduled.clear();
      for (const fn of copy) fn();
    },
  };
}

interface FakeWebSocket {
  readyState: number;
  url: string;
  sent: unknown[];
  onopen: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  send(data: unknown): void;
  close(): void;
  addEventListener(name: string, fn: (ev: Event | CloseEvent | MessageEvent) => void): void;
}

function installFakeWebSocket(): {
  instances: FakeWebSocket[];
  lastUrl: string | undefined;
} {
  const instances: FakeWebSocket[] = [];
  let lastUrl: string | undefined;

  function FakeWebSocket(this: FakeWebSocket, url: string) {
    lastUrl = url;
    this.readyState = 0; // CONNECTING
    this.url = url;
    this.sent = [];
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;

    instances.push(this);

    this.send = (data: unknown): void => {
      this.sent.push(data);
    };
    this.close = (): void => {
      this.readyState = 3; // CLOSED
      const ev = {
        code: 1000,
        reason: "",
        wasClean: true,
      } as CloseEvent;
      this.onclose?.(ev as unknown as CloseEvent);
    };
    this.addEventListener = (
      name: string,
      fn: (ev: Event | CloseEvent | MessageEvent) => void,
    ): void => {
      if (name === "open") this.onopen = fn as (ev: Event) => void;
      else if (name === "close") this.onclose = fn as (ev: CloseEvent) => void;
      else if (name === "error") this.onerror = fn as (ev: Event) => void;
      else if (name === "message") this.onmessage = fn as (ev: MessageEvent) => void;
    };
  }

  (
    FakeWebSocket as unknown as {
      CONNECTING: 0;
      OPEN: 1;
      CLOSING: 2;
      CLOSED: 3;
    }
  ).CONNECTING = 0;
  (FakeWebSocket as unknown as { CONNECTING: 0; OPEN: 1; CLOSING: 2; CLOSED: 3 }).OPEN = 1;
  (FakeWebSocket as unknown as { CONNECTING: 0; OPEN: 1; CLOSING: 2; CLOSED: 3 }).CLOSING = 2;
  (FakeWebSocket as unknown as { CONNECTING: 0; OPEN: 1; CLOSING: 2; CLOSED: 3 }).CLOSED = 3;

  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

  return {
    instances,
    get lastUrl() {
      return lastUrl;
    },
  };
}

describe("SocketService lifecycle", () => {
  let fake: ReturnType<typeof installFakeWebSocket>;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).location = locationStub;
    fake = installFakeWebSocket();
  });

  afterEach(() => {
    // Ensure no reconnect timer from a prior test fires into the next one.
    socket.disconnect();
    globalThis.WebSocket = originalWebSocket;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  // Restore the stubbed DOM global once, after the suite. The per-test restore
  // below to `originalLocation` (undefined) would otherwise clobber the stub
  // for every test after the first.
  afterAll(() => {
    (globalThis as Record<string, unknown>).location = originalLocation;
  });

  test("initial state is closed and does not connect automatically", () => {
    // The module imports only construct the service; no WebSocket is opened.
    expect(socket.state).toBe("closed");
    expect(fake.instances).toHaveLength(0);

    // The first real connect() is what opens the socket, not module load.
    const before = fake.instances.length;
    expect(before).toBe(0);
  });

  test("connect() fires open -> state becomes live", () => {
    socket.connect();
    expect(fake.instances).toHaveLength(1);
    expect(socket.state).toBe("connecting");

    fake.instances[0]!.onopen?.({} as Event);
    expect(socket.state).toBe("live");
  });

  test("disconnect() cancels reconnect timer and sets state to closed", () => {
    const timers = installFakeTimers();

    socket.connect();
    fake.instances[0]!.onopen?.({} as Event);
    expect(socket.state).toBe("live");

    // Simulate the server dropping the socket: the close path schedules a
    // reconnect because #enabled is still true.
    fake.instances[0]!.onclose?.({
      code: 1006,
      reason: "",
      wasClean: false,
    } as CloseEvent);
    expect(socket.state).toBe("closed");
    expect(timers.scheduled).toHaveLength(1);

    socket.disconnect();
    // disconnect() must clear the queued reconnect so flushPending is a no-op.
    expect(timers.scheduled).toHaveLength(0);
    expect(socket.state).toBe("closed");

    timers.flushPending();
    // No reconnect dialed in: still closed, still no websocket opened.
    expect(socket.state).toBe("closed");
    expect(fake.instances).toHaveLength(1);
  });

  test("a server-initiated close after disconnect does not reconnect", () => {
    const timers = installFakeTimers();

    socket.connect();
    fake.instances[0]!.onopen?.({} as Event);
    expect(socket.state).toBe("live");

    // The app walked away first.
    socket.disconnect();
    expect(socket.state).toBe("closed");
    expect(timers.scheduled).toHaveLength(0);

    // A server-side close arrives after the fact: with #enabled false, no
    // reconnect is ever queued.
    fake.instances[0]!.onclose?.({
      code: 1006,
      reason: "",
      wasClean: false,
    } as CloseEvent);

    expect(timers.scheduled).toHaveLength(0);
    expect(socket.state).toBe("closed");
    timers.flushPending();
    expect(fake.instances).toHaveLength(1);
  });
});
