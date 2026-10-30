import { afterEach, describe, expect, test } from "bun:test";
import type { SessionMessage, SessionSummary } from "@cc-web/protocol";
import {
  composeWorkspaceId,
  deleteSession,
  fetchSessionMessages,
  fetchWorkspaceSessions,
  renameSession,
} from "./sessions-api.ts";

/**
 * The session-history surface's HTTP half (§16.1, Task 10).
 *
 * Two calls over the composite id:
 * - `fetchWorkspaceSessions` forwards `workspace.sessions.list` to the runner that
 *   owns the workspace and answers with the parsed `SessionSummary[]`.
 * - `fetchSessionMessages` forwards `workspace.sessions.messages` and answers
 *   with the parsed `SessionMessage[]`.
 *
 * Both follow the never-throw spine of inspect-api: a network/parse failure is a
 * generic outcome, and known runner codes collapse to Vietnamese copy. `limit` and
 * `offset` ride as query parameters and are omitted when absent so an absent
 * value is never sent as the string "undefined".
 */

type Captured = { url: string; method: string; body: string; contentType: string };

const realFetch = globalThis.fetch;

function capture(status: number, body: unknown, options: { json?: boolean } = {}): Captured {
  const captured = { url: "", method: "", body: "", contentType: "" } as Captured;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input);
    captured.method = init?.method ?? "GET";
    captured.body = init?.body ? String(init.body) : "";
    captured.contentType = init?.headers
      ? Array.isArray(init.headers)
        ? ""
        : (new Headers(init.headers).get("Content-Type") ?? "")
      : "";
    const text = options.json === false ? String(body) : JSON.stringify(body);
    return new Response(text, {
      status,
      headers: { "Content-Type": options.json === false ? "text/plain" : "application/json" },
    });
  }) as typeof fetch;
  return captured;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const sessions: SessionSummary[] = [
  {
    sessionId: "sess-1",
    summary: "a session",
    lastModified: 1234567890,
    gitBranch: "main",
    cwd: "/srv/proj",
    createdAt: 1234567000,
  },
];

const messages: SessionMessage[] = [
  { type: "user", uuid: "msg-1", message: { content: "hello" } },
  { type: "assistant", uuid: "msg-2", message: { content: "hi back" } },
];

describe("composeWorkspaceId", () => {
  test("encodes a runner/workspace pair into one segment", () => {
    expect(composeWorkspaceId("r-1", "default")).toBe("r-1%2Fdefault");
    expect(composeWorkspaceId("r 1", "ws/2")).toBe("r%201%2Fws%2F2");
  });

  test("uses a bare workspace id with no runner and no slash", () => {
    expect(composeWorkspaceId(undefined, "default")).toBe("default");
  });

  test("URL-encodes an already-composite workspace id", () => {
    expect(composeWorkspaceId(undefined, "r-1/default")).toBe("r-1%2Fdefault");
  });

  test("does not double-encode if workspaceId already contains runnerId prefix", () => {
    expect(composeWorkspaceId("r-1", "r-1/default")).toBe("r-1%2Fdefault");
  });
});

describe("fetchWorkspaceSessions", () => {
  test("lists sessions through the runner and returns the parsed array", async () => {
    const captured = capture(200, {
      op: "sessions.list",
      dir: "/srv/proj",
      sessions,
    });

    const outcome = await fetchWorkspaceSessions("r-1%2Fdefault");

    expect(outcome).toEqual({ ok: true, sessions });
    expect(captured.method).toBe("GET");
    expect(captured.url).toBe("/api/workspaces/r-1%2Fdefault/sessions");
  });

  test("forwards limit and offset as query parameters", async () => {
    const captured = capture(200, {
      op: "sessions.list",
      dir: "/srv/proj",
      sessions,
    });

    await fetchWorkspaceSessions("r-1%2Fdefault", undefined, { limit: 20, offset: 10 });

    expect(captured.url).toBe("/api/workspaces/r-1%2Fdefault/sessions?limit=20&offset=10");
  });

  test("builds the composite id from a runner when given", async () => {
    const captured = capture(200, {
      op: "sessions.list",
      dir: "/srv/proj",
      sessions,
    });

    await fetchWorkspaceSessions("default", "runner-a");

    expect(captured.url).toBe("/api/workspaces/runner-a%2Fdefault/sessions");
  });

  test("omits limit/offset when neither option is set", async () => {
    const captured = capture(200, {
      op: "sessions.list",
      dir: "/srv/proj",
      sessions,
    });

    await fetchWorkspaceSessions("r-1%2Fdefault");

    expect(captured.url).toBe("/api/workspaces/r-1%2Fdefault/sessions");
  });

  test("maps a known runner code to Vietnamese copy", async () => {
    capture(404, {
      error: {
        code: "WORKSPACE_NOT_FOUND",
        message: "workspace not found",
        retryable: false,
        details: undefined,
      },
      requestId: "req-1",
    });

    const outcome = await fetchWorkspaceSessions("r-1%2Fdefault");

    expect(outcome).toEqual({
      ok: false,
      code: "WORKSPACE_NOT_FOUND",
      message: "Không tìm thấy workspace.",
    });
  });

  test("a non-JSON failure becomes a generic outcome", async () => {
    capture(503, "service unavailable", { json: false });

    const outcome = await fetchWorkspaceSessions("r-1%2Fdefault");

    expect(outcome).toEqual({
      ok: false,
      code: "error",
      message: "Không kết nối được máy chủ.",
    });
  });

  test("a network failure maps to a generic outcome", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const outcome = await fetchWorkspaceSessions("r-1%2Fdefault");

    expect(outcome).toEqual({
      ok: false,
      code: "error",
      message: "Không kết nối được máy chủ.",
    });
  });
});

describe("fetchSessionMessages", () => {
  test("reads session messages through the runner and returns the parsed array", async () => {
    const captured = capture(200, {
      op: "sessions.messages",
      sessionId: "sess-1",
      messages,
    });

    const outcome = await fetchSessionMessages("r-1%2Fdefault", "sess-1");

    expect(outcome).toEqual({ ok: true, messages });
    expect(captured.method).toBe("GET");
    expect(captured.url).toBe("/api/workspaces/r-1%2Fdefault/sessions/sess-1/messages");
  });

  test("URL-encodes a session id that contains a slash", async () => {
    const captured = capture(200, {
      op: "sessions.messages",
      sessionId: "sess/1",
      messages,
    });

    await fetchSessionMessages("r-1%2Fdefault", "sess/1");

    expect(captured.url).toBe("/api/workspaces/r-1%2Fdefault/sessions/sess%2F1/messages");
  });

  test("forwards limit and offset as query parameters", async () => {
    const captured = capture(200, {
      op: "sessions.messages",
      sessionId: "sess-1",
      messages,
    });

    await fetchSessionMessages("r-1%2Fdefault", "sess-1", undefined, { limit: 50, offset: 10 });

    expect(captured.url).toBe(
      "/api/workspaces/r-1%2Fdefault/sessions/sess-1/messages?limit=50&offset=10",
    );
  });

  test("builds the composite id from a runner when given", async () => {
    const captured = capture(200, {
      op: "sessions.messages",
      sessionId: "sess-1",
      messages,
    });

    await fetchSessionMessages("default", "sess-1", "runner-a");

    expect(captured.url).toBe("/api/workspaces/runner-a%2Fdefault/sessions/sess-1/messages");
  });

  test("a 401 auth failure maps to Vietnamese copy", async () => {
    capture(401, "unauthorized", { json: false });

    const outcome = await fetchSessionMessages("r-1%2Fdefault", "sess-1");

    expect(outcome).toEqual({
      ok: false,
      code: "error",
      message: "Không kết nối được máy chủ.",
    });
  });

  test("a network failure maps to a generic outcome", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const outcome = await fetchSessionMessages("r-1%2Fdefault", "sess-1");

    expect(outcome).toEqual({
      ok: false,
      code: "error",
      message: "Không kết nối được máy chủ.",
    });
  });
});

describe("renameSession", () => {
  test("calls PATCH /api/sessions/:id and returns true on 200", async () => {
    const captured = capture(200, { ok: true, sessionId: "sess-1", title: "New Title" });
    const ok = await renameSession("sess-1", "New Title");
    expect(ok).toBe(true);
    expect(captured.url).toBe("/api/sessions/sess-1");
    expect(captured.method).toBe("PATCH");
    expect(JSON.parse(captured.body)).toEqual({ title: "New Title" });
  });

  test("returns false on error status", async () => {
    capture(404, "not found", { json: false });
    const ok = await renameSession("sess-unknown", "New Title");
    expect(ok).toBe(false);
  });
});

describe("deleteSession", () => {
  test("calls DELETE /api/sessions/:id and returns true on 200", async () => {
    const captured = capture(200, { ok: true, sessionId: "sess-1" });
    const ok = await deleteSession("sess-1");
    expect(ok).toBe(true);
    expect(captured.url).toBe("/api/sessions/sess-1");
    expect(captured.method).toBe("DELETE");
  });

  test("returns false on error status", async () => {
    capture(404, "not found", { json: false });
    const ok = await deleteSession("sess-unknown");
    expect(ok).toBe(false);
  });
});
