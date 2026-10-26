import { describe, expect, test } from "bun:test";
import { parseInspectRequest, parseRpcResultFrame, type RpcResultFrame } from "./inspection.ts";

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
});
