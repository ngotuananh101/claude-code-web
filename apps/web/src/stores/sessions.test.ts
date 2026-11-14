import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { computed, isReactive, watch } from "vue";
import { socket } from "../services/socket.ts";
import {
  closeSession,
  openSession,
  removeSession,
  resolveSessionLive,
  sessions,
  startStore,
  updateSessionTitleInStore,
} from "./sessions.ts";

/**
 * The store is the reactive boundary between the socket singleton and the
 * components. The socket is spied on here: the store's contract under test is
 * what a delivered frame does to the reactive copy Vue reads — not how the
 * socket produces frames (services/socket is its own unit) and not how the
 * machine absorbs them (services/session-stream is its own unit).
 */

const frameListeners = new Set<(frame: Record<string, unknown>) => void>();
const sent: unknown[] = [];
const sendSpy = spyOn(socket, "send").mockImplementation((frame) => {
  sent.push(frame);
});

const onFrameSpy = spyOn(socket, "onFrame").mockImplementation(
  (listener: (frame: Record<string, unknown>) => void) => {
    frameListeners.add(listener);
    return () => frameListeners.delete(listener);
  },
);

afterAll(() => {
  onFrameSpy.mockRestore();
  sendSpy.mockRestore();
});

function deliver(frame: Record<string, unknown>): void {
  for (const listener of frameListeners) listener(frame);
}

function replayBatch(
  sessionSequenceStart: number,
  count: number,
  live = false,
): Record<string, unknown> {
  const events = Array.from({ length: count }, (_, i) => {
    const seq = sessionSequenceStart + i;
    return {
      sessionSequence: seq,
      eventId: `evt-${seq}`,
      runId: "run-1",
      attemptId: "attempt-1",
      occurredAt: "2026-10-24T00:00:00.000Z",
      type: "run.started",
      payload: { commandId: "cmd-1" },
    };
  });
  return {
    type: "session.events",
    sessionId: "s-1",
    live,
    through: sessionSequenceStart + count - 1,
    events,
  };
}

function replayFrame(sessionSequence: number): Record<string, unknown> {
  return {
    type: "session.events",
    sessionId: "s-1",
    live: false,
    through: sessionSequence,
    events: [
      {
        sessionSequence,
        eventId: `evt-${sessionSequence}`,
        runId: "run-1",
        attemptId: "attempt-1",
        occurredAt: "2026-10-24T00:00:00.000Z",
        type: "run.started",
        payload: { commandId: "cmd-1" },
      },
    ],
  };
}

describe("the sessions store's reactive mirror", () => {
  beforeEach(() => {
    closeSession();
    frameListeners.clear();
    openSession("s-1");
  });
  afterEach(() => closeSession());

  test("a replay frame hands the journal a fresh events array", () => {
    const before = sessions.stream?.events;
    deliver(replayFrame(1));
    const after = sessions.stream?.events;

    // The machine mutates its array in place, so a mirrored copy that reuses
    // the reference is invisible to Vue's shallow props compare — the journal
    // would render its first (empty) render forever.
    expect(after).not.toBe(before);
    expect(after?.length).toBe(1);
    expect(sessions.stream?.through).toBe(1);
  });

  test("every further frame hands over another fresh array", () => {
    deliver(replayFrame(1));
    const first = sessions.stream?.events;
    deliver(replayFrame(2));

    expect(sessions.stream?.events).not.toBe(first);
    expect(sessions.stream?.events?.length).toBe(2);
    expect(sessions.stream?.through).toBe(2);
  });

  test("buffers intermediate replay batches until the replay completes", () => {
    // Fresh session subscription starts with no journal until initial replay arrives
    expect(sessions.stream).toBeNull();

    // Intermediate batch (200 events, live: false)
    deliver(replayBatch(1, 200, false));
    expect(sessions.stream).toBeNull();

    // Another intermediate batch
    deliver(replayBatch(201, 200, false));
    expect(sessions.stream).toBeNull();

    // Final short batch (< 200 events) completes the replay
    deliver(replayBatch(401, 10, false));
    expect(sessions.stream).not.toBeNull();
    expect(sessions.stream?.events.length).toBe(410);
    expect(sessions.stream?.through).toBe(410);
  });

  test("a live push completes pending replay within the UI batch window", async () => {
    deliver(replayBatch(1, 200, false));
    expect(sessions.stream).toBeNull();
    deliver(replayBatch(201, 1, true));
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(sessions.stream?.events.length).toBe(201);
  });

  test("a burst of live frames publishes one immutable snapshot", async () => {
    deliver(replayFrame(1));
    const before = sessions.stream?.events;
    let publications = 0;
    const stop = watch(
      () => sessions.stream,
      () => publications++,
      { flush: "sync" },
    );
    try {
      for (let seq = 2; seq <= 101; seq++) deliver(replayBatch(seq, 1, true));
      expect(publications).toBe(0);
      expect(before?.length).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(publications).toBe(1);
      expect(sessions.stream?.through).toBe(101);
      expect(sessions.stream?.events.length).toBe(101);
      expect(sessions.stream?.events).not.toBe(before);
      expect(before?.length).toBe(1);
      expect(isReactive(sessions.stream?.events)).toBe(false);
      expect(isReactive(sessions.stream?.events[0]?.payload)).toBe(false);
    } finally {
      stop();
    }
  });

  test("telemetry keeps the render snapshot and derived value stable", async () => {
    deliver(replayFrame(1));
    let builds = 0;
    const journal = computed(() => sessions.stream?.journalEvents);
    const derived = computed(() => {
      builds++;
      return journal.value?.map((event) => event.eventId);
    });
    const first = derived.value;
    expect(first).toEqual(["evt-1"]);
    for (let seq = 2; seq <= 101; seq++) {
      const frame = replayBatch(seq, 1, true);
      const event = (frame["events"] as Record<string, unknown>[])[0]!;
      event["type"] = "run.status";
      event["payload"] = { type: "system", subtype: "thinking_tokens", estimated_tokens: seq };
      deliver(frame);
    }
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(sessions.stream?.through).toBe(101);
    expect(sessions.stream?.events.length).toBe(101);
    expect(derived.value).toBe(first);
    expect(builds).toBe(1);
  });

  test("duplicate replay frames do not republish unchanged state", () => {
    deliver(replayFrame(1));
    const first = sessions.stream;
    deliver(replayFrame(1));
    expect(sessions.stream).toBe(first);
  });

  test("approvals flush the buffered live tail without waiting", () => {
    deliver(replayFrame(1));
    deliver(replayBatch(2, 1, true));
    const frame = replayBatch(3, 1, true);
    (frame["events"] as Record<string, unknown>[])[0]!["type"] = "approval.requested";
    deliver(frame);
    expect(sessions.stream?.through).toBe(3);
    expect(sessions.stream?.journalEvents?.length).toBe(3);
  });

  test("foreign frames cannot alter the active journal", () => {
    deliver({ ...replayFrame(1), sessionId: "other" });
    deliver({ type: "session.resync_required", sessionId: "other", fromSequence: 50 });
    expect(sessions.stream).toBeNull();
  });

  test("switching sessions cancels an outstanding live publication", async () => {
    deliver(replayBatch(1, 1, true));
    openSession("other");
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(sessions.activeId).toBe("other");
    expect(sessions.stream).toBeNull();
  });

  test("an empty final replay frame publishes an exact-size backlog", () => {
    deliver(replayBatch(1, 200, false));
    expect(sessions.stream).toBeNull();
    deliver(replayBatch(201, 0, false));
    expect(sessions.stream?.through).toBe(200);
    expect(sessions.stream?.journalEvents.length).toBe(200);
  });

  test("gap repair is sent before the pending UI publication", () => {
    sent.length = 0;
    deliver(replayBatch(1, 1, true));
    deliver(replayBatch(3, 1, true));
    expect(sessions.stream).toBeNull();
    expect(sent).toEqual([{ type: "subscribe", sessionId: "s-1", afterSessionSequence: 1 }]);
  });

  test("a terminal event publishes the buffered tail immediately", () => {
    deliver(replayBatch(1, 1, true));
    const terminal = replayBatch(2, 1, true);
    (terminal["events"] as Record<string, unknown>[])[0]!["type"] = "run.finished";
    deliver(terminal);
    expect(sessions.stream?.through).toBe(2);
    expect(sessions.stream?.journalEvents.at(-1)?.type).toBe("run.finished");
  });

  test("resync clears an outstanding live snapshot immediately", () => {
    deliver(replayBatch(1, 1, true));
    deliver({ type: "session.resync_required", sessionId: "s-1", fromSequence: 5 });
    expect(sessions.stream?.through).toBe(4);
    expect(sessions.stream?.needsResync).toBe(true);
    expect(sessions.stream?.journalEvents).toEqual([]);
  });

  test("flushes intermediate replay on debounce timeout if stream stalls", async () => {
    deliver(replayBatch(1, 200, false));
    expect(sessions.stream).toBeNull();

    // Wait 220ms
    await new Promise((r) => setTimeout(r, 220));
    expect(sessions.stream).not.toBeNull();
    expect(sessions.stream?.events.length).toBe(200);
  });
});

describe("session subscription lifecycle", () => {
  beforeEach(() => {
    closeSession();
    sent.length = 0;
  });
  afterEach(() => closeSession());

  test("switch and close unsubscribe the sessions no longer observed", () => {
    openSession("first");
    openSession("second");
    closeSession();
    expect(sent).toEqual([
      { type: "subscribe", sessionId: "first", afterSessionSequence: 0 },
      { type: "unsubscribe", sessionId: "first" },
      { type: "subscribe", sessionId: "second", afterSessionSequence: 0 },
      { type: "unsubscribe", sessionId: "second" },
    ]);
  });

  test("reconnect uses the received watermark even before a UI flush", () => {
    let reopen: (() => void) | undefined;
    const reopenSpy = spyOn(socket, "onReopen").mockImplementation((listener) => {
      reopen = listener;
      return () => {};
    });
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async () => new Response("", { status: 503 }), { preconnect: () => {} }),
    );
    const stateSpy = spyOn(socket, "onState").mockImplementation(() => () => {});
    try {
      startStore();
      openSession("s-1");
      deliver(replayBatch(1, 200, false));
      expect(sessions.stream).toBeNull();
      sent.length = 0;
      reopen?.();
      expect(sent).toEqual([{ type: "subscribe", sessionId: "s-1", afterSessionSequence: 200 }]);
    } finally {
      reopenSpy.mockRestore();
      fetchSpy.mockRestore();
      stateSpy.mockRestore();
    }
  });
});

describe("resolveSessionLive", () => {
  test("the listing's live flag survives a replay frame that said live:false", () => {
    // Replay batches always carry live:false, and an in-flight run can sit
    // quiet long enough for its last frame to be a replay one — the header
    // dot must not go out while the server says a run is in flight.
    expect(resolveSessionLive(true, false)).toBe(true);
    expect(resolveSessionLive(true, null)).toBe(true);
  });

  test("a live push shows a run even before the listing refreshes", () => {
    expect(resolveSessionLive(false, true)).toBe(true);
  });

  test("neither source live means not live", () => {
    expect(resolveSessionLive(false, false)).toBe(false);
    expect(resolveSessionLive(false, null)).toBe(false);
    expect(resolveSessionLive(undefined, false)).toBe(false);
  });
});

describe("session store mutations", () => {
  test("updateSessionTitleInStore updates title for matching session", () => {
    sessions.sessions = [
      {
        sessionId: "sess-1",
        title: "Cũ",
        watermark: 0,
        eventCount: 0,
        lastEventType: null,
        lastIngestedAt: 0,
        live: false,
        runnerId: null,
        workspaceId: null,
        sdkSessionId: null,
      },
    ];

    updateSessionTitleInStore("sess-1", "Mới");
    expect(sessions.sessions[0]?.title).toBe("Mới");
  });

  test("removeSession removes session and clears activeId if active", () => {
    sessions.sessions = [
      {
        sessionId: "sess-1",
        title: "Phiên 1",
        watermark: 0,
        eventCount: 0,
        lastEventType: null,
        lastIngestedAt: 0,
        live: false,
        runnerId: null,
        workspaceId: null,
        sdkSessionId: null,
      },
      {
        sessionId: "sess-2",
        title: "Phiên 2",
        watermark: 0,
        eventCount: 0,
        lastEventType: null,
        lastIngestedAt: 0,
        live: false,
        runnerId: null,
        workspaceId: null,
        sdkSessionId: null,
      },
    ];
    sessions.activeId = "sess-1";

    removeSession("sess-1");
    expect(sessions.sessions).toHaveLength(1);
    expect(sessions.sessions[0]?.sessionId).toBe("sess-2");
    expect(sessions.activeId).toBeNull();
  });
});
