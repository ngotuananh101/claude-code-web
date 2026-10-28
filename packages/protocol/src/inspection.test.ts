import { describe, expect, test } from "bun:test";
import {
  type FsBrowseResult,
  parseBrowseRequest,
  parseInspectRequest,
  parseRpcResultFrame,
  parseSessionsRequest,
  type RpcResultFrame,
  type SessionMessagesResult,
  type SessionsListResult,
} from "./inspection.ts";

/**
 * Bounded inspection RPC (§23).
 *
 * Two shapes arrive from the network and both are parsed here before anything
 * acts on them: the request the server put in a command payload, and the result
 * frame the runner sends back. Neither parser is a security boundary on its own
 * — path safety belongs to the runner, which is the side that owns the
 * filesystem — but a parser that accepted an unknown `op` would dispatch work
 * nobody defined, so the vocabulary is closed here.
 */

describe("parseInspectRequest", () => {
  test("accepts file.list and file.read with a relative path", () => {
    expect(parseInspectRequest("workspace.inspect", { op: "file.list", path: "src" })).toEqual({
      op: "file.list",
      path: "src",
    });
    expect(parseInspectRequest("workspace.inspect", { op: "file.read", path: "a.ts" })).toEqual({
      op: "file.read",
      path: "a.ts",
    });
  });

  test("treats an empty path as the workspace root for file.list", () => {
    expect(parseInspectRequest("workspace.inspect", { op: "file.list", path: "" })).toEqual({
      op: "file.list",
      path: "",
    });
  });

  test("accepts git.changes with no path", () => {
    expect(parseInspectRequest("workspace.inspect", { op: "git.changes" })).toEqual({
      op: "git.changes",
    });
  });

  test("rejects an op the kind does not own", () => {
    expect(parseInspectRequest("workspace.inspect", { op: "diagnostics" })).toBeUndefined();
    expect(parseInspectRequest("config.inspect", { op: "file.read", path: "a" })).toBeUndefined();
  });

  test("accepts diagnostics only under config.inspect", () => {
    expect(parseInspectRequest("config.inspect", { op: "diagnostics" })).toEqual({
      op: "diagnostics",
    });
  });

  test("rejects a non-string path and a non-object payload", () => {
    expect(parseInspectRequest("workspace.inspect", { op: "file.read", path: 1 })).toBeUndefined();
    expect(parseInspectRequest("workspace.inspect", null)).toBeUndefined();
    expect(parseInspectRequest("workspace.inspect", "file.read")).toBeUndefined();
  });

  test("rejects an unknown kind", () => {
    expect(
      parseInspectRequest("workspace.file.write", { op: "file.read", path: "a" }),
    ).toBeUndefined();
  });
});

describe("parseBrowseRequest", () => {
  test("accepts a path and showHidden flag", () => {
    expect(parseBrowseRequest("workspace.fs.browse", { path: "src", showHidden: true })).toEqual({
      path: "src",
      showHidden: true,
    });
  });

  test("treats an absent path as the workspace root (user homedir default on the runner)", () => {
    expect(parseBrowseRequest("workspace.fs.browse", {})).toEqual({});
  });

  test("treats an empty path as the workspace root", () => {
    expect(parseBrowseRequest("workspace.fs.browse", { path: "" })).toEqual({ path: "" });
  });

  test("rejects a non-string path and a non-boolean showHidden", () => {
    expect(parseBrowseRequest("workspace.fs.browse", { path: 1 })).toBeUndefined();
    expect(
      parseBrowseRequest("workspace.fs.browse", { path: "src", showHidden: "yes" }),
    ).toBeUndefined();
  });

  test("rejects a non-object payload", () => {
    expect(parseBrowseRequest("workspace.fs.browse", null)).toBeUndefined();
    expect(parseBrowseRequest("workspace.fs.browse", "src")).toBeUndefined();
  });

  test("rejects an unknown kind", () => {
    expect(
      parseBrowseRequest("workspace.inspect", { op: "fs.browse", path: "src" }),
    ).toBeUndefined();
    expect(parseBrowseRequest("workspace.sessions.list", { path: "src" })).toBeUndefined();
  });
});

describe("parseSessionsRequest", () => {
  test("accepts sessions.list with a dir and a limit", () => {
    expect(
      parseSessionsRequest("workspace.sessions.list", { dir: "/home/user/project", limit: 10 }),
    ).toEqual({ op: "sessions.list", dir: "/home/user/project", limit: 10 });
  });

  test("accepts sessions.list with an offset", () => {
    expect(
      parseSessionsRequest("workspace.sessions.list", { dir: "/home/user/project", offset: 20 }),
    ).toEqual({ op: "sessions.list", dir: "/home/user/project", offset: 20 });
  });

  test("accepts sessions.messages with a sessionId and optional dir", () => {
    expect(
      parseSessionsRequest("workspace.sessions.messages", {
        sessionId: "msg-123",
        dir: "/home/user/project",
        limit: 50,
      }),
    ).toEqual({
      op: "sessions.messages",
      sessionId: "msg-123",
      dir: "/home/user/project",
      limit: 50,
    });
  });

  test("accepts sessions.messages with only a sessionId", () => {
    expect(parseSessionsRequest("workspace.sessions.messages", { sessionId: "msg-123" })).toEqual({
      op: "sessions.messages",
      sessionId: "msg-123",
    });
  });

  test("rejects sessions.list without a dir", () => {
    expect(parseSessionsRequest("workspace.sessions.list", {})).toBeUndefined();
    expect(parseSessionsRequest("workspace.sessions.list", { dir: 123 })).toBeUndefined();
  });

  test("rejects sessions.messages without a sessionId", () => {
    expect(parseSessionsRequest("workspace.sessions.messages", {})).toBeUndefined();
    expect(parseSessionsRequest("workspace.sessions.messages", { sessionId: "" })).toBeUndefined();
  });

  test("rejects out-of-bounds limit values", () => {
    expect(
      parseSessionsRequest("workspace.sessions.list", { dir: "/p", limit: 0 }),
    ).toBeUndefined();
    expect(
      parseSessionsRequest("workspace.sessions.list", { dir: "/p", limit: 201 }),
    ).toBeUndefined();
    expect(
      parseSessionsRequest("workspace.sessions.messages", { sessionId: "s", limit: 501 }),
    ).toBeUndefined();
    expect(
      parseSessionsRequest("workspace.sessions.messages", { sessionId: "s", limit: 0 }),
    ).toBeUndefined();
  });

  test("rejects a non-object payload", () => {
    expect(parseSessionsRequest("workspace.sessions.list", null)).toBeUndefined();
    expect(parseSessionsRequest("workspace.sessions.list", "dir")).toBeUndefined();
  });

  test("rejects an unknown kind", () => {
    expect(parseSessionsRequest("workspace.fs.browse", { dir: "/p", limit: 10 })).toBeUndefined();
    expect(
      parseSessionsRequest("workspace.inspect", { op: "sessions.list", dir: "/p" }),
    ).toBeUndefined();
  });
});

describe("parseRpcResultFrame", () => {
  test("accepts a well-formed ok frame and an error frame", () => {
    const ok: RpcResultFrame = {
      type: "rpc.result",
      commandId: "c1",
      ok: true,
      result: { op: "git.changes", entries: [], truncated: false },
    };
    expect(parseRpcResultFrame(ok)).toEqual(ok);

    const bad: RpcResultFrame = {
      type: "rpc.result",
      commandId: "c1",
      ok: false,
      error: { code: "PATH_OUTSIDE_WORKSPACE", message: "refused" },
    };
    expect(parseRpcResultFrame(bad)).toEqual(bad);
  });

  test("rejects a wrong type, an empty commandId, and an ok frame with no result", () => {
    expect(parseRpcResultFrame({ type: "other", commandId: "c1", ok: true })).toBeUndefined();
    expect(
      parseRpcResultFrame({
        type: "rpc.result",
        commandId: "",
        ok: true,
        result: { op: "git.changes", entries: [], truncated: false },
      }),
    ).toBeUndefined();
    expect(parseRpcResultFrame({ type: "rpc.result", commandId: "c1", ok: true })).toBeUndefined();
  });

  test("rejects an error frame with no error object", () => {
    expect(parseRpcResultFrame({ type: "rpc.result", commandId: "c1", ok: false })).toBeUndefined();
  });

  test("accepts an ok frame carrying a browse result", () => {
    const browse: FsBrowseResult = {
      op: "fs.browse",
      currentPath: "/",
      parentPath: null,
      shortcuts: [{ label: "Home", path: "~" }],
      entries: [
        { name: "src", path: "/src", isDir: true, isGitRepo: true, hasClaudeProject: false },
      ],
      truncated: false,
    };
    const frame = parseRpcResultFrame({
      type: "rpc.result",
      commandId: "c1",
      ok: true,
      result: browse,
    });
    expect(frame).toEqual({
      type: "rpc.result",
      commandId: "c1",
      ok: true,
      result: browse,
    });
  });

  test("accepts an ok frame carrying a sessions.list result", () => {
    const list: SessionsListResult = {
      op: "sessions.list",
      dir: "/home/user/project",
      sessions: [{ sessionId: "s1", summary: "old convo", lastModified: 1234567890 }],
    };
    const frame = parseRpcResultFrame({
      type: "rpc.result",
      commandId: "c1",
      ok: true,
      result: list,
    });
    expect(frame).toEqual({
      type: "rpc.result",
      commandId: "c1",
      ok: true,
      result: list,
    });
  });

  test("accepts an ok frame carrying a sessions.messages result", () => {
    const messages: SessionMessagesResult = {
      op: "sessions.messages",
      sessionId: "s1",
      messages: [{ type: "user", uuid: "u1", message: { content: "hello" } }],
    };
    const frame = parseRpcResultFrame({
      type: "rpc.result",
      commandId: "c1",
      ok: true,
      result: messages,
    });
    expect(frame).toEqual({
      type: "rpc.result",
      commandId: "c1",
      ok: true,
      result: messages,
    });
  });
});
