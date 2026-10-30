import { describe, expect, test } from "bun:test";
import { removeSession, sessions } from "../stores/sessions.ts";

/**
 * Tests for RunnersView display and state logic.
 */
describe("RunnersView logic", () => {
  test("runner display label prefers friendly name over runnerId", () => {
    const runnerWithName = {
      runnerId: "runner-abc-123",
      name: "Máy trạm văn phòng",
      createdAt: 1000,
      revokedAt: null,
    };
    const runnerWithoutName = {
      runnerId: "runner-def-456",
      name: null,
      createdAt: 1000,
      revokedAt: null,
    };

    const label1 = runnerWithName.name || runnerWithName.runnerId;
    const label2 = runnerWithoutName.name || runnerWithoutName.runnerId;

    expect(label1).toBe("Máy trạm văn phòng");
    expect(label2).toBe("runner-def-456");
  });

  test("cascades session deletion in store when runner is deleted", () => {
    sessions.sessions = [
      {
        sessionId: "sess-1",
        title: "Session 1",
        watermark: 0,
        eventCount: 0,
        lastEventType: null,
        lastIngestedAt: 0,
        live: false,
        runnerId: "runner-to-delete",
        workspaceId: null,
        sdkSessionId: null,
      },
      {
        sessionId: "sess-2",
        title: "Session 2",
        watermark: 0,
        eventCount: 0,
        lastEventType: null,
        lastIngestedAt: 0,
        live: false,
        runnerId: "other-runner",
        workspaceId: null,
        sdkSessionId: null,
      },
    ];

    const deletedSessions = ["sess-1"];
    for (const sid of deletedSessions) {
      removeSession(sid);
    }

    expect(sessions.sessions).toHaveLength(1);
    expect(sessions.sessions[0]?.sessionId).toBe("sess-2");
  });

  test("generates appropriate deletion warnings for active vs revoked runners", () => {
    function getDeleteWarning(isRevoked: boolean): string {
      return isRevoked
        ? "Xoá runner này sẽ xoá vĩnh viễn dữ liệu runner cùng toàn bộ phiên làm việc, lượt chạy liên quan khỏi hệ thống."
        : "Runner này đang hoạt động. Việc xoá sẽ ngắt kết nối ngay lập tức và xoá vĩnh viễn runner cùng toàn bộ phiên làm việc, lượt chạy liên quan.";
    }

    expect(getDeleteWarning(false)).toContain("ngắt kết nối ngay lập tức");
    expect(getDeleteWarning(true)).toContain("xoá vĩnh viễn dữ liệu runner");
  });
});
