import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SESSIONS_CAPABILITY,
  SESSIONS_LIST_DEFAULT_LIMIT,
  SESSIONS_LIST_MAX_LIMIT,
  SESSIONS_MESSAGES_DEFAULT_LIMIT,
} from "@cc-web/protocol";
import type { SessionsSdk } from "./handler.ts";
import { createSessionsHandler, SESSIONS_CAPABILITIES } from "./handler.ts";

const fixtureRoots: string[] = [];

/**
 * A `~/.claude/projects` fixture holding one session's subagent meta files —
 * the shape `readSubagentMetaIndex` reads, at both nesting levels Claude Code
 * uses (`subagents/` for Agent children, `subagents/workflows/<run>/` for
 * Workflow children).
 */
async function makeProjectsFixture(
  sessionId: string,
  agents: Array<
    | { kind: "agent"; agentId: string; meta: Record<string, unknown> }
    | { kind: "workflow"; runId: string; agentId: string; meta: Record<string, unknown> }
  >,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cc-web-projects-"));
  fixtureRoots.push(root);
  for (const agent of agents) {
    const dir =
      agent.kind === "workflow"
        ? join(root, "-tmp-proj", sessionId, "subagents", "workflows", agent.runId)
        : join(root, "-tmp-proj", sessionId, "subagents");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `agent-${agent.agentId}.meta.json`), JSON.stringify(agent.meta));
  }
  return root;
}

afterAll(async () => {
  await Promise.all(fixtureRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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
      {
        type: "assistant" as const,
        uuid: "m2",
        session_id: "s1",
        parent_tool_use_id: null,
        message: { content: "hello" },
      },
      {
        type: "assistant" as const,
        uuid: "m3",
        session_id: "s1",
        parent_tool_use_id: "toolu-agent-1",
        message: { content: "subagent step" },
      },
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
      messages: Array<{
        type: string;
        uuid: string;
        message: unknown;
        parentToolUseId?: string;
      }>;
    };
    expect(result.op).toBe("sessions.messages");
    expect(result.sessionId).toBe("s1");
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toMatchObject({ type: "user", uuid: "m1" });
    expect("parentToolUseId" in result.messages[0]!).toBe(false);
    expect(result.messages[1]).toMatchObject({ type: "assistant", uuid: "m2" });
    expect("parentToolUseId" in result.messages[1]!).toBe(false);
    expect(result.messages[2]).toMatchObject({
      type: "assistant",
      uuid: "m3",
      parentToolUseId: "toolu-agent-1",
    });
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

  test("loads subagent transcripts via listSubagents + getSubagentMessages, links Agent toolUseId, skips housekeeping ids, and redacts sensitive fields", async () => {
    const mainMessages = [
      {
        type: "assistant" as const,
        uuid: "m-main-1",
        session_id: "s1",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu-agent-explore",
              name: "Agent",
              input: { description: "Explore repo", subagent_type: "Explore" },
            },
          ],
        },
      },
      {
        type: "user" as const,
        uuid: "m-main-2",
        session_id: "s1",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-agent-explore",
              content: [{ type: "text", text: "Found files.\nagentId: a37b4b1e86821c096" }],
            },
          ],
        },
      },
    ];

    const listSubagentsCalls: Array<[string, { dir?: string } | undefined]> = [];
    const getSubagentMessagesCalls: Array<
      [string, string, { dir?: string; limit?: number; offset?: number } | undefined]
    > = [];

    const { sdk } = makeMockSdk([], mainMessages);
    sdk.listSubagents = mock(async (sessionId: string, opts?: { dir?: string }) => {
      listSubagentsCalls.push([sessionId, opts]);
      return [
        "a37b4b1e86821c096",
        "ae3454d16c5171399",
        "acompact-0fd4323b87bc3b5b",
        "aprompt_suggestion-407bd7",
      ];
    });
    sdk.getSubagentMessages = mock(
      async (
        sessionId: string,
        agentId: string,
        opts?: { dir?: string; limit?: number; offset?: number },
      ) => {
        getSubagentMessagesCalls.push([sessionId, agentId, opts]);
        if (agentId === "a37b4b1e86821c096") {
          return [
            {
              type: "assistant" as const,
              uuid: "sub-m1",
              message: {
                role: "assistant",
                apiKey: "sk-ant-leak-secret-1234567890",
                content: [{ type: "tool_use", id: "toolu-sub-read", name: "Read", input: {} }],
              },
            },
          ];
        }
        return [
          {
            type: "assistant" as const,
            uuid: "wf-m1",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Workflow finding" }],
            },
          },
        ];
      },
    );

    const handler = createSessionsHandler({
      workspacePathFor: (id: string) => (id === "ws-2" ? "/abs/ws-2" : undefined),
      sdk,
    });

    const frame = (await handler(
      command({
        kind: "workspace.sessions.messages",
        payload: { op: "sessions.messages", sessionId: "s1", dir: "ws-2" },
      }),
    )) as {
      ok: boolean;
      result: {
        messages: Array<{
          type: string;
          uuid: string;
          message: Record<string, unknown>;
          parentToolUseId?: string;
          agentId?: string;
        }>;
      };
    };

    expect(frame.ok).toBe(true);
    expect(listSubagentsCalls).toEqual([["s1", { dir: "/abs/ws-2" }]]);
    // Housekeeping compact & prompt_suggestion subagents must be skipped
    expect(getSubagentMessagesCalls.map((c) => c[1])).toEqual([
      "a37b4b1e86821c096",
      "ae3454d16c5171399",
    ]);

    expect(frame.result.messages).toHaveLength(4);
    const agentMsg = frame.result.messages.find((m) => m.uuid === "sub-m1");
    expect(agentMsg).toBeDefined();
    expect(agentMsg?.agentId).toBe("a37b4b1e86821c096");
    expect(agentMsg?.parentToolUseId).toBe("toolu-agent-explore");
    expect("apiKey" in (agentMsg?.message ?? {})).toBe(false);

    const wfMsg = frame.result.messages.find((m) => m.uuid === "wf-m1");
    expect(wfMsg).toBeDefined();
    expect(wfMsg?.agentId).toBe("ae3454d16c5171399");
    expect("parentToolUseId" in (wfMsg ?? {})).toBe(false);
  });

  test("links a Workflow's children to the Workflow call and labels them from their meta files", async () => {
    // The real Workflow result is launch text, not JSON: no `workflowProgress`,
    // no per-agent ids. The only thing it names is the run, so the run id is
    // the bridge between "these five transcripts" and "the block that started
    // them" — and each child's `.meta.json` supplies the label.
    const launchText = [
      "Workflow launched in background. Task ID: wwgczx5jh",
      "Summary: Verify quickjs-ng assets/digests",
      "Transcript dir: /home/u/.claude/projects/p/s1/subagents/workflows/wf_af8103d7-91f",
      "Run ID: wf_af8103d7-91f",
    ].join("\n");

    const mainMessages = [
      {
        type: "assistant" as const,
        uuid: "m-wf-call",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_00_zlmqteg6c7sxiru8lyea2eej",
              name: "Workflow",
              input: {},
            },
          ],
        },
      },
      {
        type: "user" as const,
        uuid: "m-wf-res",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_00_zlmqteg6c7sxiru8lyea2eej",
              content: launchText,
            },
          ],
        },
      },
    ];

    const projectsDir = await makeProjectsFixture("s1", [
      {
        kind: "workflow",
        runId: "wf_af8103d7-91f",
        agentId: "a51c84ff15e3201f4",
        meta: {
          agentType: "workflow-subagent",
          description: "plan-critique",
          workflowPhase: "Scout",
        },
      },
      {
        kind: "agent",
        agentId: "a004bc3d38e1acc56",
        meta: {
          agentType: "Explore",
          description: "Explore repo",
          toolUseId: "call_agent_explore",
        },
      },
    ]);

    const { sdk } = makeMockSdk([], mainMessages);
    sdk.listSubagents = mock(async () => ["a51c84ff15e3201f4", "a004bc3d38e1acc56"]);
    sdk.getSubagentMessages = mock(async (_sid: string, agentId: string) => [
      {
        type: "assistant" as const,
        uuid: `sub-${agentId}`,
        message: { role: "assistant", content: [{ type: "text", text: "finding" }] },
      },
    ]);

    const handler = createSessionsHandler({
      workspacePathFor: () => "/tmp/proj",
      sdk,
      projectsDir,
    });

    const frame = (await handler(
      command({
        kind: "workspace.sessions.messages",
        payload: { op: "sessions.messages", sessionId: "s1", dir: "/tmp/proj" },
      }),
    )) as {
      ok: boolean;
      result: {
        messages: Array<{
          uuid: string;
          agentId?: string;
          parentToolUseId?: string;
          agentType?: string;
          agentLabel?: string;
          workflowPhase?: string;
          workflowToolUseId?: string;
        }>;
      };
    };

    expect(frame.ok).toBe(true);

    const workflowChild = frame.result.messages.find((m) => m.uuid === "sub-a51c84ff15e3201f4");
    expect(workflowChild).toMatchObject({
      agentId: "a51c84ff15e3201f4",
      parentToolUseId: "call_00_zlmqteg6c7sxiru8lyea2eej",
      // The call is named twice, on purpose: `parentToolUseId` says what it
      // hangs under, `workflowToolUseId` says that parent is a run rather than
      // an Agent call — the browser keys rows on the child, not on the shared id.
      workflowToolUseId: "call_00_zlmqteg6c7sxiru8lyea2eej",
      agentType: "workflow-subagent",
      agentLabel: "plan-critique",
      workflowPhase: "Scout",
    });

    // An Agent child still links by its own result's agentId…
    const agentChild = frame.result.messages.find((m) => m.uuid === "sub-a004bc3d38e1acc56");
    expect(agentChild).toMatchObject({ agentId: "a004bc3d38e1acc56", agentLabel: "Explore repo" });
    // …and when the main transcript does not reach back to the spawning block
    // (it is read with a limit), the meta file's toolUseId is the link.
    expect(agentChild?.parentToolUseId).toBe("call_agent_explore");
    expect(agentChild?.workflowToolUseId).toBeUndefined();
  });

  test("finds a Workflow launch in the session transcript when the page does not reach it", async () => {
    // The reason the transcript file is read at all: the SDK's `getSessionMessages`
    // is windowed, so for a long session the `Workflow` call sits far above the
    // page the browser asked for and the pairing is missing exactly when a run is
    // old enough to inspect. Nothing in this test's main messages names a run.
    const launchText = [
      "Workflow launched in background. Task ID: wwgczx5jh",
      "Summary: Verify quickjs-ng assets/digests",
      "Run ID: wf_af8103d7-91f",
    ].join("\n");

    const projectsDir = await makeProjectsFixture("s1", [
      {
        kind: "workflow",
        runId: "wf_af8103d7-91f",
        agentId: "a51c84ff15e3201f4",
        meta: { agentType: "workflow-subagent", description: "plan-critique" },
      },
    ]);
    const transcript = [
      {
        type: "assistant",
        uuid: "m-wf-call",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_00_zlmqteg6c7sxiru8lyea2eej",
              name: "Workflow",
              input: {},
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "m-wf-res",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_00_zlmqteg6c7sxiru8lyea2eej",
              content: launchText,
            },
          ],
        },
      },
    ];
    await writeFile(
      join(projectsDir, "-tmp-proj", "s1.jsonl"),
      transcript.map((line) => `${JSON.stringify(line)}\n`).join(""),
    );

    const { sdk } = makeMockSdk(
      [],
      [{ type: "assistant", uuid: "m-tail", message: { content: [] } }],
    );
    sdk.listSubagents = mock(async () => ["a51c84ff15e3201f4"]);
    sdk.getSubagentMessages = mock(async () => [
      {
        type: "assistant" as const,
        uuid: "sub-a51c84ff15e3201f4",
        message: { role: "assistant", content: [{ type: "text", text: "finding" }] },
      },
    ]);

    const handler = createSessionsHandler({
      workspacePathFor: () => "/tmp/proj",
      sdk,
      projectsDir,
    });
    const frame = (await handler(
      command({
        kind: "workspace.sessions.messages",
        payload: { op: "sessions.messages", sessionId: "s1", dir: "/tmp/proj" },
      }),
    )) as {
      ok: boolean;
      result: {
        messages: Array<{ uuid: string; parentToolUseId?: string; workflowToolUseId?: string }>;
      };
    };

    const child = frame.result.messages.find((m) => m.uuid === "sub-a51c84ff15e3201f4");
    expect(child?.workflowToolUseId).toBe("call_00_zlmqteg6c7sxiru8lyea2eej");
    expect(child?.parentToolUseId).toBe("call_00_zlmqteg6c7sxiru8lyea2eej");
  });

  test("a session with no meta files still returns every subagent transcript", async () => {
    // Labels are decoration: losing the meta directory must not cost the
    // history that makes the popup useful.
    const { sdk } = makeMockSdk([], []);
    sdk.listSubagents = mock(async () => ["a51c84ff15e3201f4"]);
    sdk.getSubagentMessages = mock(async () => [
      {
        type: "assistant" as const,
        uuid: "sub-1",
        message: { role: "assistant", content: [{ type: "text", text: "finding" }] },
      },
    ]);

    const handler = createSessionsHandler({
      workspacePathFor: () => "/tmp/proj",
      sdk,
      projectsDir: join(tmpdir(), "cc-web-no-such-projects-dir"),
    });

    const frame = (await handler(
      command({
        kind: "workspace.sessions.messages",
        payload: { op: "sessions.messages", sessionId: "s1", dir: "/tmp/proj" },
      }),
    )) as { ok: boolean; result: { messages: Array<{ uuid: string; agentId?: string }> } };

    expect(frame.ok).toBe(true);
    expect(frame.result.messages.find((m) => m.uuid === "sub-1")?.agentId).toBe(
      "a51c84ff15e3201f4",
    );
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
      { type: "system", uuid: "m2", message: { text: "sys" }, parentToolUseId: "x" },
    ]);
  });
});
