import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { socket } from "../services/socket.ts";
import {
  openSession,
  removeSession,
  resolveSessionLive,
  sessions,
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

const onFrameSpy = spyOn(socket, "onFrame").mockImplementation(
  (listener: (frame: Record<string, unknown>) => void) => {
    frameListeners.add(listener);
    return () => frameListeners.delete(listener);
  },
);

afterAll(() => {
  onFrameSpy.mockRestore();
});

function deliver(frame: Record<string, unknown>): void {
  for (const listener of frameListeners) listener(frame);
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
    frameListeners.clear();
    openSession("s-1");
  });

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
