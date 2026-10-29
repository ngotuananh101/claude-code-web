import { afterEach, describe, expect, test } from "bun:test";
import type { SessionSummary } from "@cc-web/protocol";
import {
  buildRunRequest,
  loadWorkspaceSessions,
  NEW_SESSION,
  resumeSessionIdFor,
  sessionOption,
  splitCompositeId,
} from "../features/composer/composer-logic.ts";

/**
 * Task 12 — Composer workspace & session picker logic tests (§15.1, §16.1).
 *
 * Composer.vue is a Vue SFC that cannot be compiled in the Bun test
 * environment (no @vue/compiler-sfc), so — following the codebase convention
 * established by FolderBrowserModal.test.ts — these tests exercise the pure
 * logic module that backs the component: `features/composer/composer-logic.ts`.
 * The module owns the testable behaviour: session option building, workspace
 * session loading + sorting, resolveSessionResume decision, and composite id
 * splitting.
 *
 * `startRun` itself is already covered by runs-api.test.ts; here we verify the
 * composer-side logic that decides whether `resumeSessionId` is sent and with
 * what value.
 */

const realFetch = globalThis.fetch;

type Captured = { url: string; method: string; body: unknown };

function capture(status: number, body: unknown): Captured {
  const captured: Captured = { url: "", method: "", body: undefined };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input);
    captured.method = init?.method ?? "GET";
    captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return captured;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const sampleSessions: SessionSummary[] = [
  {
    sessionId: "sess-old",
    summary: "old conversation",
    gitBranch: "main",
    cwd: "/srv/proj",
    lastModified: 1_000_000,
    createdAt: 900_000,
  },
  {
    sessionId: "sess-new",
    summary: "newer conversation",
    gitBranch: "dev",
    cwd: "/srv/proj",
    lastModified: 2_000_000,
    createdAt: 1_500_000,
  },
  {
    sessionId: "sess-nosummary",
    summary: "",
    lastModified: 3_000_000,
  },
];

describe("sessionOption", () => {
  const NOW = 1_700_000_000_000;

  test("uses the summary as the label when present", () => {
    const session: SessionSummary = {
      sessionId: "s1",
      summary: "discussed the API",
      lastModified: NOW - 60_000,
    };
    expect(sessionOption(session, NOW)).toEqual({
      value: "s1",
      label: "discussed the API · 1 phút trước",
    });
  });

  test("falls back to sessionId when summary is empty", () => {
    const session: SessionSummary = {
      sessionId: "s2",
      summary: "",
      lastModified: NOW - 60_000,
    };
    expect(sessionOption(session, NOW)).toEqual({
      value: "s2",
      label: "s2 · 1 phút trước",
    });
  });

  test("falls back to sessionId when summary is undefined", () => {
    const session: SessionSummary = {
      sessionId: "s3",
      summary: undefined as unknown as string,
      lastModified: NOW - 60_000,
    };
    expect(sessionOption(session, NOW)).toEqual({
      value: "s3",
      label: "s3 · 1 phút trước",
    });
  });
});

describe("loadWorkspaceSessions", () => {
  test("returns sorted sessions when fetch succeeds", async () => {
    capture(200, {
      op: "sessions.list",
      dir: "/srv/proj",
      sessions: sampleSessions,
    });

    const result = await loadWorkspaceSessions("proj", "runner-a");

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Newest lastModified first, then older; the no-summary one is newest overall.
      expect(result.sessions.map((s) => s.sessionId)).toEqual([
        "sess-nosummary",
        "sess-new",
        "sess-old",
      ]);
    }
  });

  test("returns ok:false with message when fetch fails", async () => {
    capture(404, {
      error: { code: "WORKSPACE_NOT_FOUND", message: "not found" },
    });

    const result = await loadWorkspaceSessions("missing", "runner-a");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("Không tìm thấy workspace.");
    }
  });

  test("returns an empty sessions list when the workspace has no sessions", async () => {
    capture(200, {
      op: "sessions.list",
      dir: "/srv/empty",
      sessions: [],
    });

    const result = await loadWorkspaceSessions("proj", "runner-a");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessions).toEqual([]);
    }
  });

  test("forwards the composite id built from runnerId + workspaceId", async () => {
    const captured = capture(200, {
      op: "sessions.list",
      dir: "/srv/proj",
      sessions: sampleSessions,
    });

    await loadWorkspaceSessions("default", "runner-b");

    // fetchWorkspaceSessions composes runnerId/workspaceId → URL-encoded segment.
    expect(captured.url).toBe("/api/workspaces/runner-b%2Fdefault/sessions");
    expect(captured.method).toBe("GET");
  });

  test("a network failure maps to ok:false", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;

    const result = await loadWorkspaceSessions("proj", "runner-a");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("Không kết nối được máy chủ.");
    }
  });
});

describe("resumeSessionIdFor", () => {
  test("returns undefined for the 'new' sentinel (session is omitted from payload)", () => {
    expect(resumeSessionIdFor(NEW_SESSION)).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(resumeSessionIdFor("")).toBeUndefined();
  });

  test("returns the session id when an existing session is selected", () => {
    expect(resumeSessionIdFor("sess-123")).toBe("sess-123");
  });

  test("returns the session id for a session id that looks like a UUID", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(resumeSessionIdFor(uuid)).toBe(uuid);
  });
});

describe("splitCompositeId", () => {
  test("splits a runnerId/workspaceId composite into its pair", () => {
    const result = splitCompositeId("runner-a/ws-1");
    expect(result).toEqual({ runnerId: "runner-a", workspaceId: "ws-1" });
  });

  test("handles workspaceIds that contain a slash (URL-encoded by caller)", () => {
    const result = splitCompositeId("runner-a/ws/sub");
    // The first segment is the runner; everything after is the workspace id.
    expect(result.runnerId).toBe("runner-a");
    expect(result.workspaceId).toBe("ws/sub");
  });

  test("single segment has empty workspaceId", () => {
    const result = splitCompositeId("runner-a");
    expect(result.runnerId).toBe("runner-a");
    expect(result.workspaceId).toBe("");
  });
});

describe("buildRunRequest — resumeSessionId handling", () => {
  const baseInputs = {
    prompt: "hello world",
    permission: "default",
    model: "default",
    workspaceId: "ws-proj",
    projectRunnerId: "runner-a",
    runnerId: "runner-a",
    branch: "current",
    selectedSession: NEW_SESSION,
    isNewSessionPage: true,
    branchOptions: ["main", "dev"],
  };

  test("when 'new' is selected, resumeSessionId is omitted from the payload", () => {
    const body = buildRunRequest(baseInputs);

    expect(body.resumeSessionId).toBeUndefined();
    expect(body.prompt).toBe("hello world");
    expect(body.permissionMode).toBe("default");
    // Workspace context rides on the new-session page.
    expect(body.workspaceId).toBe("ws-proj");
    expect(body.runnerId).toBe("runner-a");
    // "current" branch is not sent.
    expect(body.branch).toBeUndefined();
  });

  test("when an existing session is selected, resumeSessionId is included", () => {
    const body = buildRunRequest({
      ...baseInputs,
      selectedSession: "sess-123",
    });

    expect(body.resumeSessionId).toBe("sess-123");
    expect(body.prompt).toBe("hello world");
    expect(body.permissionMode).toBe("default");
  });

  test("when an empty-string session is selected, resumeSessionId is omitted", () => {
    const body = buildRunRequest({
      ...baseInputs,
      selectedSession: "",
    });

    expect(body.resumeSessionId).toBeUndefined();
  });

  test("model is omitted when 'default', included otherwise", () => {
    const defaultModel = buildRunRequest(baseInputs);
    expect(defaultModel.model).toBeUndefined();

    const withModel = buildRunRequest({
      ...baseInputs,
      model: "opus",
    });
    expect(withModel.model).toBe("opus");
  });

  test("branch is sent only when a real branch is chosen on the new-session page", () => {
    const current = buildRunRequest(baseInputs);
    expect(current.branch).toBeUndefined();

    const realBranch = buildRunRequest({
      ...baseInputs,
      branch: "dev",
    });
    expect(realBranch.branch).toBe("dev");
  });

  test("on an existing session page, workspace/runner/branch context is omitted", () => {
    const body = buildRunRequest({
      ...baseInputs,
      isNewSessionPage: false,
      selectedSession: "sess-1",
    });

    expect(body.workspaceId).toBeUndefined();
    expect(body.runnerId).toBeUndefined();
    expect(body.branch).toBeUndefined();
    // But resumeSessionId is still forwarded.
    expect(body.resumeSessionId).toBe("sess-1");
  });

  test("on the new-session page with an undefined projectRunnerId, no workspace context is sent (legacy fallback)", () => {
    const body = buildRunRequest({
      ...baseInputs,
      projectRunnerId: undefined,
    });

    // No runner declaration → prompt-only body.
    expect(body.workspaceId).toBeUndefined();
    expect(body.runnerId).toBeUndefined();
    expect(body.branch).toBeUndefined();
  });

  test("prompt is trimmed", () => {
    const body = buildRunRequest({
      ...baseInputs,
      prompt: "  hello world  ",
    });
    expect(body.prompt).toBe("hello world");
  });
});
