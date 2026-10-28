import { describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import {
  SESSIONS_CAPABILITY,
  SESSIONS_LIST_DEFAULT_LIMIT,
  SESSIONS_LIST_MAX_LIMIT,
  SESSIONS_MESSAGES_DEFAULT_LIMIT,
} from "@cc-web/protocol";
import type { SessionsSdk } from "./handler.ts";
import { createSessionsHandler, SESSIONS_CAPABILITIES } from "./handler.ts";

function command(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    commandId: "cmd-1",
    runnerId: "runner-a",
    kind: "workspace.sessions.list",
    issuedAt: "2026-10-26T00:00:00.000Z",
    payload: { op: "sessions.list", dir: "/tmp/proj" },
    ...overrides,
  };
}

type ListSessionsCall = { dir: string; limit: number; offset?: number; includeProgrammatic: false };
type GetMessagesCall = {
  dir?: string;
  limit: number;
  offset?: number;
  includeSystemMessages: false;
};

function makeMockSdk(
  sessions: Array<Record<string, unknown>> = [],
  messages: Array<Record<string, unknown>> = [],
): {
  sdk: SessionsSdk;
  listSessionsCalls: ListSessionsCall[];
  getSessionMessagesCalls: Array<[string, GetMessagesCall]>;
} {
  const listSessionsCalls: ListSessionsCall[] = [];
  const getSessionMessagesCalls: Array<[string, GetMessagesCall]> = [];
  const sdk: SessionsSdk = {
    listSessions: mock(async (opts: ListSessionsCall) => {
      listSessionsCalls.push(opts);
      return sessions as never;
    }) as SessionsSdk["listSessions"],
    getSessionMessages: mock(async (sid: string, opts: GetMessagesCall) => {
      getSessionMessagesCalls.push([sid, opts]);
      return messages as never;
    }) as SessionsSdk["getSessionMessages"],
  };
  return { sdk, listSessionsCalls, getSessionMessagesCalls };
}

const throwingSdk = (): SessionsSdk => ({
  listSessions: mock(async () => {
    throw new Error("ANTHROPIC_API_KEY=sk-ant-api03-LeakMe123456 failure");
  }) as SessionsSdk["listSessions"],
  getSessionMessages: mock(async () => []) as SessionsSdk["getSessionMessages"],
});

describe("SESSIONS_CAPABILITIES", () => {
  test("advertises the sessions capability", () => {
    expect(SESSIONS_CAPABILITIES).toEqual([SESSIONS_CAPABILITY]);
  });
});

describe("command shape", () => {
  const handler = createSessionsHandler({ workspacePathFor: () => "/tmp/proj" });

  test("refuses a non-object command with UNSUPPORTED_COMMAND", async () => {
    const frame = (await handler(null)) as Record<string, unknown>;
    expect(frame).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_COMMAND" } });
  });

  test("refuses a non-sessions kind with UNSUPPORTED_COMMAND", async () => {
    const frame = (await handler(
      command({ kind: "workspace.inspect", payload: { op: "file.list" } }),
    )) as Record<string, unknown>;
    expect(frame).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_COMMAND" } });
  });

  test("refuses a malformed payload with UNSUPPORTED_COMMAND", async () => {
    const frame = (await handler(command({ payload: { dir: 123 } }))) as Record<string, unknown>;
    expect(frame).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_COMMAND" } });
  });

  test("refuses a missing dir in sessions.list with UNSUPPORTED_COMMAND", async () => {
    const frame = (await handler(
      command({ kind: "workspace.sessions.list", payload: { op: "sessions.list" } }),
    )) as Record<string, unknown>;
    expect(frame).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_COMMAND" } });
  });

  test("echoes the commandId on every frame", async () => {
    const { sdk } = makeMockSdk();
    const handler = createSessionsHandler({
      workspacePathFor: () => "/tmp/proj",
      sdk,
    });

    const frame = (await handler(
      command({
        commandId: "my-id",
        kind: "workspace.sessions.list",
        payload: { op: "sessions.list", dir: "/tmp/proj" },
      }),
    )) as Record<string, unknown>;
    expect(frame["type"]).toBe("rpc.result");
    expect(frame["commandId"]).toBe("my-id");
  });
});

describe("workspace.sessions.list", () => {
  test("resolves workspaceId through workspacePathFor and calls sdk.listSessions", async () => {
    const { sdk, listSessionsCalls } = makeMockSdk([
      {
        sessionId: "abc",
        summary: "hello",
        lastModified: 1000,
        createdAt: 500,
        gitBranch: "main",
        cwd: "/abs/ws-1",
      },
    ]);
    const handler = createSessionsHandler({
      workspacePathFor: (id: string) => (id === "ws-1" ? "/abs/ws-1" : undefined),
      sdk,
    });

    const frame = (await handler(
      command({
        kind: "workspace.sessions.list",
        payload: { op: "sessions.list", dir: "ws-1" },
      }),
    )) as Record<string, unknown>;

    expect(frame.ok).toBe(true);
    const result = frame.result as {
      op: string;
      dir: string;
      sessions: Array<Record<string, unknown>>;
    };
    expect(result.op).toBe("sessions.list");
    expect(result.dir).toBe("/abs/ws-1");
    expect(result.sessions).toEqual([
      {
        sessionId: "abc",
        summary: "hello",
        lastModified: 1000,
        createdAt: 500,
        gitBranch: "main",
        cwd: "/abs/ws-1",
      },
    ]);
    expect(listSessionsCalls).toHaveLength(1);
    expect(listSessionsCalls[0]).toMatchObject({
      dir: "/abs/ws-1",
      includeProgrammatic: false,
    });
  });

  test("falls back to request.dir when workspacePathFor returns undefined", async () => {
    const { sdk, listSessionsCalls } = makeMockSdk([
      { sessionId: "s1", summary: "test", lastModified: 2000 },
    ]);
    const handler = createSessionsHandler({
      workspacePathFor: () => undefined,
      sdk,
    });

    const frame = (await handler(
      command({
        kind: "workspace.sessions.list",
        payload: { op: "sessions.list", dir: "/custom/path" },
      }),
    )) as Record<string, unknown>;

    expect(frame.ok).toBe(true);
    const result = frame.result as { dir: string };
    expect(result.dir).toBe(resolve("/custom/path"));
    expect(listSessionsCalls[0]!.dir).toBe(resolve("/custom/path"));
  });

  test("normalizes relative request.dir with path.resolve", async () => {
    const { sdk, listSessionsCalls } = makeMockSdk();
    const handler = createSessionsHandler({
      workspacePathFor: () => undefined,
      sdk,
    });

    const frame = (await handler(
      command({
        kind: "workspace.sessions.list",
        payload: { op: "sessions.list", dir: "rel/path" },
      }),
    )) as Record<string, unknown>;

    expect(frame.ok).toBe(true);
    const result = frame.result as { dir: string; sessions: unknown[] };
    expect(result.dir).toBe(resolve("rel/path"));
    expect(listSessionsCalls[0]!.dir).toBe(resolve("rel/path"));
  });

  test("applies default limit when none provided", async () => {
    const { sdk, listSessionsCalls } = makeMockSdk();
    const handler = createSessionsHandler({
      workspacePathFor: () => "/tmp/proj",
      sdk,
    });

    await handler(
      command({
        kind: "workspace.sessions.list",
        payload: { op: "sessions.list", dir: "/tmp/proj" },
      }),
    );

    expect(listSessionsCalls[0]!.limit).toBe(SESSIONS_LIST_DEFAULT_LIMIT);
  });

  test("refuses an out-of-bounds limit as UNSUPPORTED_COMMAND", async () => {
    const handler = createSessionsHandler({
      workspacePathFor: () => "/tmp/proj",
      sdk: makeMockSdk().sdk,
    });
    const frame = (await handler(
      command({
        kind: "workspace.sessions.list",
        payload: { op: "sessions.list", dir: "/tmp/proj", limit: 9999 },
      }),
    )) as Record<string, unknown>;
    expect(frame).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_COMMAND" } });
  });

  test("accepts a limit at the max boundary", async () => {
    const { sdk, listSessionsCalls } = makeMockSdk();
    const handler = createSessionsHandler({
      workspacePathFor: () => "/tmp/proj",
      sdk,
    });

    await handler(
      command({
        kind: "workspace.sessions.list",
        payload: { op: "sessions.list", dir: "/tmp/proj", limit: SESSIONS_LIST_MAX_LIMIT },
      }),
    );

    expect(listSessionsCalls[0]!.limit).toBe(SESSIONS_LIST_MAX_LIMIT);
  });

  test("passes through offset when provided", async () => {
    const { sdk, listSessionsCalls } = makeMockSdk();
    const handler = createSessionsHandler({
      workspacePathFor: () => "/tmp/proj",
      sdk,
    });

    await handler(
      command({
        kind: "workspace.sessions.list",
        payload: { op: "sessions.list", dir: "/tmp/proj", offset: 50 },
      }),
    );

    expect(listSessionsCalls[0]!.offset).toBe(50);
  });

  test("includesProgrammatic is always false", async () => {
    const { sdk, listSessionsCalls } = makeMockSdk();
    const handler = createSessionsHandler({
      workspacePathFor: () => "/tmp/proj",
      sdk,
    });

    await handler(
      command({
        kind: "workspace.sessions.list",
        payload: { op: "sessions.list", dir: "/tmp/proj" },
      }),
    );

    expect(listSessionsCalls[0]!.includeProgrammatic).toBe(false);
  });
});

describe("workspace.sessions.messages", () => {
  test("calls sdk.getSessionMessages with sessionId and resolved dir", async () => {
    const messages = [
      { type: "user" as const, uuid: "m1", session_id: "s1", message: { content: "hi" } },
      { type: "assistant" as const, uuid: "m2", session_id: "s1", message: { content: "hello" } },
    ];
    const { sdk, getSessionMessagesCalls } = makeMockSdk([], messages);
    const handler = createSessionsHandler({
      workspacePathFor: (id: string) => (id === "ws-2" ? "/abs/ws-2" : undefined),
      sdk,
    });

    const frame = (await handler(
      command({
        kind: "workspace.sessions.messages",
        payload: { op: "sessions.messages", sessionId: "s1", dir: "ws-2" },
      }),
    )) as Record<string, unknown>;

    expect(frame.ok).toBe(true);
    const result = frame.result as {
      op: string;
      sessionId: string;
      messages: Array<{ type: string; uuid: string; message: unknown }>;
    };
    expect(result.op).toBe("sessions.messages");
    expect(result.sessionId).toBe("s1");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({ type: "user", uuid: "m1" });
    expect(result.messages[1]).toMatchObject({ type: "assistant", uuid: "m2" });
    expect(getSessionMessagesCalls).toEqual([
      [
        "s1",
        { dir: "/abs/ws-2", limit: SESSIONS_MESSAGES_DEFAULT_LIMIT, includeSystemMessages: false },
      ],
    ]);
  });

  test("uses request.dir fallback when workspacePathFor returns undefined", async () => {
    const { sdk, getSessionMessagesCalls } = makeMockSdk(
      [],
      [{ type: "user", uuid: "m1", message: {} }],
    );
    const handler = createSessionsHandler({
      workspacePathFor: () => undefined,
      sdk,
    });

    const frame = (await handler(
      command({
        kind: "workspace.sessions.messages",
        payload: { op: "sessions.messages", sessionId: "s1", dir: "/custom/dir" },
      }),
    )) as Record<string, unknown>;

    expect(frame.ok).toBe(true);
    expect(getSessionMessagesCalls[0]![1].dir).toBe(resolve("/custom/dir"));
  });

  test("omits dir when not provided", async () => {
    const { sdk, getSessionMessagesCalls } = makeMockSdk();
    const handler = createSessionsHandler({
      workspacePathFor: () => undefined,
      sdk,
    });

    await handler(
      command({
        kind: "workspace.sessions.messages",
        payload: { op: "sessions.messages", sessionId: "s1" },
      }),
    );

    expect(getSessionMessagesCalls[0]![1].dir).toBeUndefined();
  });

  test("applies default limit when none provided", async () => {
    const { sdk, getSessionMessagesCalls } = makeMockSdk();
    const handler = createSessionsHandler({
      workspacePathFor: () => "/tmp/proj",
      sdk,
    });

    await handler(
      command({
        kind: "workspace.sessions.messages",
        payload: { op: "sessions.messages", sessionId: "s1", dir: "/tmp/proj" },
      }),
    );

    expect(getSessionMessagesCalls[0]![1].limit).toBe(SESSIONS_MESSAGES_DEFAULT_LIMIT);
  });

  test("refuses an out-of-bounds limit as UNSUPPORTED_COMMAND", async () => {
    const handler = createSessionsHandler({
      workspacePathFor: () => "/tmp/proj",
      sdk: makeMockSdk().sdk,
    });
    const frame = (await handler(
      command({
        kind: "workspace.sessions.messages",
        payload: { op: "sessions.messages", sessionId: "s1", dir: "/tmp/proj", limit: 9999 },
      }),
    )) as Record<string, unknown>;
    expect(frame).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_COMMAND" } });
  });

  test("includeSystemMessages is always false", async () => {
    const { sdk, getSessionMessagesCalls } = makeMockSdk();
    const handler = createSessionsHandler({
      workspacePathFor: () => "/tmp/proj",
      sdk,
    });

    await handler(
      command({
        kind: "workspace.sessions.messages",
        payload: { op: "sessions.messages", sessionId: "s1", dir: "/tmp/proj" },
      }),
    );

    expect(getSessionMessagesCalls[0]![1].includeSystemMessages).toBe(false);
  });
});

describe("error handling", () => {
  test("refuses when the SDK throws with a redacted message", async () => {
    const { sdk, getSessionMessagesCalls } = makeMockSdk();
    sdk.listSessions = mock(async () => {
      throw new Error("ANTHROPIC_API_KEY=sk-ant-api03-LeakMe123456 failure");
    }) as SessionsSdk["listSessions"];
    void getSessionMessagesCalls;

    const handler = createSessionsHandler({
      workspacePathFor: () => "/tmp/proj",
      sdk,
    });

    const frame = (await handler(
      command({
        kind: "workspace.sessions.list",
        payload: { op: "sessions.list", dir: "/tmp/proj" },
      }),
    )) as Record<string, unknown>;

    expect(frame).toMatchObject({ ok: false, error: { code: "SDK_ERROR" } });
    expect((frame.error as { message: string }).message).not.toContain("sk-ant-api03-LeakMe123456");
  });

  test("refuses when listSessions throws a generic error", async () => {
    const { sdk, getSessionMessagesCalls } = makeMockSdk();
    sdk.listSessions = mock(async () => {
      throw new Error("session store unavailable");
    }) as SessionsSdk["listSessions"];
    void getSessionMessagesCalls;

    const handler = createSessionsHandler({
      workspacePathFor: () => "/tmp/proj",
      sdk,
    });

    const frame = (await handler(
      command({
        kind: "workspace.sessions.list",
        payload: { op: "sessions.list", dir: "/tmp/proj" },
      }),
    )) as Record<string, unknown>;

    expect(frame).toMatchObject({ ok: false, error: { code: "SDK_ERROR" } });
    expect((frame.error as { message: string }).message).toContain("session store unavailable");
  });

  test("redacts secret-shaped text from all refusal messages", async () => {
    const { sdk, getSessionMessagesCalls } = makeMockSdk();
    sdk.listSessions = mock(async () => {
      throw new Error("Bearer sk-ant-api03-ThisIsASecretTokenThatShouldBeRedacted failure");
    }) as SessionsSdk["listSessions"];
    void getSessionMessagesCalls;

    const handler = createSessionsHandler({
      workspacePathFor: () => "/tmp/proj",
      sdk,
    });

    const frame = (await handler(
      command({
        kind: "workspace.sessions.list",
        payload: { op: "sessions.list", dir: "/tmp/proj" },
      }),
    )) as { error: { message: string } };

    expect(frame.error.message).not.toContain(
      "sk-ant-api03-ThisIsASecretTokenThatShouldBeRedacted",
    );
  });

  test("never throws even on unexpected error types", async () => {
    const { sdk, getSessionMessagesCalls } = makeMockSdk();
    sdk.listSessions = mock(async () => {
      throw new Error("unexpected");
    }) as SessionsSdk["listSessions"];
    void getSessionMessagesCalls;
    void throwingSdk;

    const handler = createSessionsHandler({
      workspacePathFor: () => "/tmp/proj",
      sdk,
    });

    // Non-object command
    const badFrame = (await handler("not-an-object")) as Record<string, unknown>;
    expect(badFrame.ok).toBe(false);

    // SDK throws
    const sdkFrame = (await handler(command({}))) as Record<string, unknown>;
    expect(sdkFrame.ok).toBe(false);
  });
});

describe("maps SDK session info to SessionSummary", () => {
  test("maps all protocol fields from SDKSessionInfo", async () => {
    const sdkSession = {
      sessionId: "sess-uuid",
      summary: "test summary",
      lastModified: 1234567890,
      gitBranch: "feature/x",
      cwd: "/some/cwd",
      createdAt: 1234567000,
      customTitle: "ignored",
      firstPrompt: "ignored",
      fileSize: 9999,
      tag: "ignored",
    };
    const { sdk } = makeMockSdk([sdkSession]);
    const handler = createSessionsHandler({
      workspacePathFor: () => "/tmp/proj",
      sdk,
    });

    const frame = (await handler(
      command({
        kind: "workspace.sessions.list",
        payload: { op: "sessions.list", dir: "/tmp/proj" },
      }),
    )) as {
      result: { sessions: Array<Record<string, unknown>> };
    };

    expect(frame.result.sessions).toEqual([
      {
        sessionId: "sess-uuid",
        summary: "test summary",
        lastModified: 1234567890,
        gitBranch: "feature/x",
        cwd: "/some/cwd",
        createdAt: 1234567000,
      },
    ]);
  });

  test("omits optional fields when SDK does not provide them", async () => {
    const sdkSession = { sessionId: "s1", summary: "t", lastModified: 1000 };
    const { sdk } = makeMockSdk([sdkSession]);
    const handler = createSessionsHandler({
      workspacePathFor: () => "/tmp/proj",
      sdk,
    });

    const frame = (await handler(
      command({
        kind: "workspace.sessions.list",
        payload: { op: "sessions.list", dir: "/tmp/proj" },
      }),
    )) as { result: { sessions: Array<Record<string, unknown>> } };

    expect(frame.result.sessions[0]).toEqual({
      sessionId: "s1",
      summary: "t",
      lastModified: 1000,
    });
  });

  test("maps SDK SessionMessage to protocol SessionMessage (drops SDK-only fields)", async () => {
    const sdkMsgs = [
      {
        type: "user" as const,
        uuid: "m1",
        session_id: "s1",
        message: { text: "hi" },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
      {
        type: "system" as const,
        uuid: "m2",
        session_id: "s1",
        message: { text: "sys" },
        parent_tool_use_id: "x",
        parent_agent_id: "y",
      },
    ];
    const { sdk } = makeMockSdk([], sdkMsgs);
    const handler = createSessionsHandler({
      workspacePathFor: () => "/tmp/proj",
      sdk,
    });

    const frame = (await handler(
      command({
        kind: "workspace.sessions.messages",
        payload: { op: "sessions.messages", sessionId: "s1", dir: "/tmp/proj" },
      }),
    )) as { result: { messages: Array<Record<string, unknown>> } };

    expect(frame.result.messages).toEqual([
      { type: "user", uuid: "m1", message: { text: "hi" } },
      { type: "system", uuid: "m2", message: { text: "sys" } },
    ]);
  });
});
