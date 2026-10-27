import { describe, expect, test } from "bun:test";
import { parseInspectRequest, parseRpcResultFrame } from "./inspection.ts";
import { parseMutationRequest } from "./mutation.ts";

test("parses file.write with all three fields", () => {
  expect(
    parseMutationRequest("workspace.file.write", {
      op: "file.write", path: "src/a.ts", content: "next\n", expectedHash: "abc",
    }),
  ).toEqual({ op: "file.write", path: "src/a.ts", content: "next\n", expectedHash: "abc" });
});

test("refuses file.write with a non-string field", () => {
  expect(
    parseMutationRequest("workspace.file.write", { op: "file.write", path: "a", content: 1, expectedHash: "x" }),
  ).toBeUndefined();
  expect(
    parseMutationRequest("workspace.file.write", { op: "file.write", path: "a", content: "x" }),
  ).toBeUndefined();
});

test("file.revert accepts an absent-file assertion", () => {
  expect(
    parseMutationRequest("workspace.file.revert", { op: "file.revert", path: "new.ts", expectedHash: null }),
  ).toEqual({ op: "file.revert", path: "new.ts", expectedHash: null });
});

test("refuses an op under the wrong kind", () => {
  expect(parseMutationRequest("workspace.file.write", { op: "file.revert", path: "a", expectedHash: null }))
    .toBeUndefined();
  expect(parseMutationRequest("nope", { op: "file.write", path: "a", content: "", expectedHash: "" }))
    .toBeUndefined();
});

test("parses workspace.revert with a digest", () => {
  expect(parseMutationRequest("workspace.revert", { op: "workspace.revert", planDigest: "d1" }))
    .toEqual({ op: "workspace.revert", planDigest: "d1" });
  expect(parseMutationRequest("workspace.revert", { op: "workspace.revert", planDigest: "" }))
    .toBeUndefined();
});

test("snapshot.status is an inspect op and not a mutation op", () => {
  expect(parseInspectRequest("workspace.inspect", { op: "snapshot.status" })).toEqual({ op: "snapshot.status" });
  expect(parseInspectRequest("config.inspect", { op: "snapshot.status" })).toBeUndefined();
  expect(parseMutationRequest("workspace.inspect", { op: "snapshot.status" })).toBeUndefined();
});

test("an rpc.result may carry a mutation result", () => {
  const frame = parseRpcResultFrame({
    type: "rpc.result", commandId: "c1", ok: true,
    result: { op: "file.write", path: "a.ts", hash: "h", size: 3 },
  });
  expect(frame).toEqual({
    type: "rpc.result", commandId: "c1", ok: true,
    result: { op: "file.write", path: "a.ts", hash: "h", size: 3 },
  });
});
