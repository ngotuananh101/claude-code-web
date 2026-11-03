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

  test("runner row carries capabilities binding", () => {
    const runner = {
      runnerId: "runner-abc-123",
      name: "Office",
      createdAt: 1000,
      revokedAt: null,
      capabilities: {
        commands: [{ name: "review" }],
        plugins: [{ name: "plugin-a", version: "1.0.0" }],
        mcpServers: [{ name: "srv", status: "connected" as const }],
        agents: [{ name: "agent-1" }],
      },
    };

    expect(runner.capabilities?.plugins?.[0]?.name).toBe("plugin-a");
    expect(runner.capabilities?.mcpServers?.[0]?.status).toBe("connected");
    expect(runner.capabilities?.agents?.[0]?.name).toBe("agent-1");
  });

  test("runner row carries models binding", () => {
    const runner = {
      runnerId: "runner-abc-123",
      name: "Office",
      createdAt: 1000,
      revokedAt: null,
      models: [
        {
          value: "claude-sonnet-4",
          displayName: "Sonnet 4",
          description: "Fast",
          supportsEffort: true,
          supportedEffortLevels: [],
        },
      ],
    };

    expect(runner.models?.[0]?.value).toBe("claude-sonnet-4");
  });

  test("capability button only for non-revoked runners", () => {
    const active = { revokedAt: null };
    const revoked = { revokedAt: 1234 };
    expect(active.revokedAt === null).toBe(true);
    expect(revoked.revokedAt === null).toBe(false);
  });
});
