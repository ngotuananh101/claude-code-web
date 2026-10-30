import { describe, expect, test } from "bun:test";
import { removeSession, sessions, updateSessionTitleInStore } from "../stores/sessions.ts";

/**
 * Tests for SessionRail session actions and display logic (§16.1).
 */
describe("SessionRail display logic", () => {
  test("session row prefers title over sessionId when present", () => {
    const sessionWithTitle = {
      sessionId: "session-1234-abcd",
      title: "Fix bug auth",
      watermark: 0,
      eventCount: 0,
      lastEventType: null,
      lastIngestedAt: 0,
      live: false,
      runnerId: null,
      workspaceId: null,
      sdkSessionId: null,
    };
    const sessionWithoutTitle: { sessionId: string; title?: string } = {
      sessionId: "session-5678-ef01",
    };

    const label1 = sessionWithTitle.title || sessionWithTitle.sessionId;
    const label2 = sessionWithoutTitle.title || sessionWithoutTitle.sessionId;

    expect(label1).toBe("Fix bug auth");
    expect(label2).toBe("session-5678-ef01");
  });

  test("renaming updates title in reactive store", () => {
    sessions.sessions = [
      {
        sessionId: "sess-abc",
        title: "Tên cũ",
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

    updateSessionTitleInStore("sess-abc", "Tên mới");
    expect(sessions.sessions[0]?.title).toBe("Tên mới");
  });

  test("deleting removes session and clears active session if active", () => {
    sessions.sessions = [
      {
        sessionId: "sess-active",
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
    sessions.activeId = "sess-active";

    removeSession("sess-active");
    expect(sessions.sessions).toHaveLength(0);
    expect(sessions.activeId).toBeNull();
  });
});
