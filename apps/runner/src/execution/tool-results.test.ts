import { describe, expect, test } from "bun:test";
import { isToolResultFrame, toolCompletionsOf } from "./tool-results.ts";

/**
 * §12.3: a complete `user` frame's tool_result blocks are the SDK's evidence a
 * tool ran and returned — the raw frame currently lands in the outbox as a
 * generic `run.status` blob. These tests pin the pure mapping that replaces
 * that noise with one `tool.completed` per block, and the guard that decides
 * which frames are safe to replace.
 */

function userFrame(content: unknown): Record<string, unknown> {
  return { type: "user", message: { role: "user", content } };
}

function toolResult(toolUseId: string, content: unknown, isError = false): Record<string, unknown> {
  return { type: "tool_result", tool_use_id: toolUseId, content, is_error: isError };
}

describe("isToolResultFrame", () => {
  test("a frame of only tool_result blocks is a tool-result frame", () => {
    expect(
      isToolResultFrame(userFrame([toolResult("toolu-1", "ok"), toolResult("toolu-2", "err")])),
    ).toBe(true);
  });

  test("a mixed frame (text + tool_result) is not", () => {
    expect(
      isToolResultFrame(userFrame([{ type: "text", text: "hi" }, toolResult("toolu-1", "ok")])),
    ).toBe(false);
  });

  test("string content is not", () => {
    expect(isToolResultFrame(userFrame("plain echo"))).toBe(false);
  });

  test("empty or missing content is not", () => {
    expect(isToolResultFrame(userFrame([]))).toBe(false);
    expect(isToolResultFrame({ type: "user", message: {} })).toBe(false);
    expect(isToolResultFrame({ type: "user" })).toBe(false);
  });

  test("non-user frames are not", () => {
    expect(
      isToolResultFrame({ type: "assistant", message: { content: [toolResult("t", "x")] } }),
    ).toBe(false);
  });
});

describe("toolCompletionsOf", () => {
  test("one completion per block, in content order, with the call id", () => {
    const completions = toolCompletionsOf(
      userFrame([toolResult("toolu-1", "ok"), toolResult("toolu-2", "bad", true)]),
    );
    expect(completions.map((c) => c.toolCallId)).toEqual(["toolu-1", "toolu-2"]);
    expect(completions.map((c) => c.isError)).toEqual([false, true]);
  });

  test("string content becomes the output summary", () => {
    const [completion] = toolCompletionsOf(userFrame([toolResult("toolu-1", "hello output")]));
    expect(completion?.outputSummary).toBe("hello output");
  });

  test("text blocks are joined into the output summary", () => {
    const [completion] = toolCompletionsOf(
      userFrame([
        toolResult("toolu-1", [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
          { type: "image", source: { type: "base64" } },
        ]),
      ]),
    );
    expect(completion?.outputSummary).toBe("line one\nline two");
  });

  test("no text means no output summary key at all", () => {
    const [completion] = toolCompletionsOf(
      userFrame([toolResult("toolu-1", [{ type: "image", source: { type: "base64" } }])]),
    );
    expect(completion).toBeDefined();
    expect("outputSummary" in (completion ?? {})).toBe(false);
  });

  test("blocks without a usable tool_use_id are skipped", () => {
    expect(
      toolCompletionsOf(
        userFrame([{ type: "tool_result", content: "x" }, toolResult("toolu-2", "y")]),
      ),
    ).toEqual([{ toolCallId: "toolu-2", isError: false, outputSummary: "y" }]);
    expect(
      toolCompletionsOf(userFrame([{ type: "tool_result", tool_use_id: 7, content: "x" }])),
    ).toEqual([]);
  });

  test("the output summary is masked and capped through the whole mapping", () => {
    // §19.4 seam: only the summarizeToolInput helper is unit-tested on its
    // own — this pins that the wiring cannot ship raw tool output past it.
    // A credential-bearing header inside the text is masked, and an oversized
    // output is truncated to the hard cap.
    const leaking = toolResult("toolu-1", "Authorization: Bearer sk-ant-1234567890abcdef");
    const [masked] = toolCompletionsOf(userFrame([leaking]));
    expect(masked?.outputSummary).toContain("[REDACTED]");
    expect(masked?.outputSummary).not.toContain("sk-ant-1234567890abcdef");

    const huge = toolResult("toolu-2", "x".repeat(5000));
    const [capped] = toolCompletionsOf(userFrame([huge]));
    expect(capped?.outputSummary?.length).toBeLessThanOrEqual(2000);
  });

  test("non-tool-result frames yield no completions without throwing", () => {
    expect(toolCompletionsOf(userFrame("echo"))).toEqual([]);
    expect(toolCompletionsOf({ type: "assistant", message: { content: [] } })).toEqual([]);
    expect(toolCompletionsOf({ type: "user", message: null })).toEqual([]);
    expect(toolCompletionsOf({})).toEqual([]);
  });
});
