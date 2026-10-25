import { describe, expect, test } from "bun:test";
import { createSdkStream, type QueryFn } from "./index.ts";

/**
 * The SDK adapter (§7.1, §10.2, §10.3).
 *
 * This is the only module allowed to import the SDK (§4.2). The import is lazy
 * so a unit test can import this module — and the runner that depends on it —
 * without pulling in a bundled Claude Code binary.
 *
 * What is asserted here is the option mapping, not the model: an override that
 * is absent must be *omitted*, because §8.1 makes `inherit` mean "the SDK
 * option is not set", never "set to a default that resembles inherit".
 */

type QueryParams = Parameters<QueryFn>[0];

/**
 * Run the adapter against a fake `query` and return the options it received.
 *
 * The fake's stream is never drained: consuming it would ask the adapter for
 * frames it does not have.
 */
function captureOptions(input: Parameters<typeof createSdkStream>[0]): QueryParams {
  let captured: QueryParams | undefined;
  const fake: QueryFn = (params) => {
    captured = params;
    return (async function* () {})() as ReturnType<QueryFn>;
  };

  const stream = createSdkStream(input, () => fake);
  void stream[Symbol.asyncIterator]()
    .next()
    .catch(() => {});

  if (captured === undefined) throw new Error("query was not called");
  return captured;
}

describe("mapping a run to SDK options", () => {
  test("sets the workspace as cwd and inherits the three config sources", () => {
    const params = captureOptions({ prompt: "hi", cwd: "/w" });

    expect(params.options?.cwd).toBe("/w");
    expect(params.options?.settingSources).toEqual(["user", "project", "local"]);
    expect(params.options?.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
  });

  test("passes the prompt through", () => {
    expect(captureOptions({ prompt: "fix the bug", cwd: "/w" }).prompt).toBe("fix the bug");
  });

  test("omits resume entirely for a new session", () => {
    const params = captureOptions({ prompt: "hi", cwd: "/w" });

    // §8.1: an absent value is omitted, not set to undefined.
    expect(params.options !== undefined && "resume" in params.options).toBe(false);
  });

  test("resumes by explicit id when one is known", () => {
    const params = captureOptions({ prompt: "hi", cwd: "/w", resume: "sdk-1" });

    expect(params.options?.resume).toBe("sdk-1");
    // §10.4: `continue` would pick whichever conversation happened to be newest.
    expect(params.options !== undefined && "continue" in params.options).toBe(false);
  });

  test("passes cancellation through as an abort controller", () => {
    const controller = new AbortController();
    const params = captureOptions({ prompt: "hi", cwd: "/w", abort: controller.signal });

    expect(params.options?.["abortController"]).toBeInstanceOf(AbortController);
    const sdkController = params.options?.["abortController"] as AbortController;
    expect(sdkController.signal.aborted).toBe(false);
  });

  test("aborts the SDK controller when the caller's signal fires", () => {
    const controller = new AbortController();
    const params = captureOptions({ prompt: "hi", cwd: "/w", abort: controller.signal });

    controller.abort();

    // The SDK only sees its own controller; without this link a cancel would
    // never reach the CLI subprocess (§14.2).
    const sdkController = params.options?.["abortController"] as AbortController;
    expect(sdkController.signal.aborted).toBe(true);
  });

  test("requests partial messages so the UI can stream", () => {
    expect(captureOptions({ prompt: "hi", cwd: "/w" }).options?.includePartialMessages).toBe(true);
  });

  test("forwards permissionMode when the run carries one", () => {
    const params = captureOptions({ prompt: "hi", cwd: "/w", permissionMode: "acceptEdits" });

    expect(params.options?.["permissionMode"]).toBe("acceptEdits");
  });

  test("forwards model when the run names one", () => {
    const params = captureOptions({ prompt: "hi", cwd: "/w", model: "opus" });

    expect(params.options?.["model"]).toBe("opus");
  });

  test("omits model entirely when the run does not name one", () => {
    const params = captureOptions({ prompt: "hi", cwd: "/w" });

    // §8.1: the SDK's own default model is what "inherit" means — setting
    // undefined here would shadow it with a lie.
    expect(params.options !== undefined && "model" in params.options).toBe(false);
  });

  test("forwards the approval gate as canUseTool when one is given", () => {
    const canUseTool = async () => ({ behavior: "deny", message: "no" }) as const;
    const params = captureOptions({ prompt: "hi", cwd: "/w", canUseTool });

    expect(params.options?.["canUseTool"]).toBe(canUseTool);
  });
});

describe("the lazy import", () => {
  test("does not load the SDK until the stream is consumed", () => {
    // An eager import would make every runner test load the bundled binary
    // merely by importing the code under test.
    let loaded = false;
    const fake: QueryFn = () => {
      loaded = true;
      return (async function* () {})() as ReturnType<QueryFn>;
    };

    const stream = createSdkStream({ prompt: "hi", cwd: "/w" }, () => fake);
    expect(loaded).toBe(false);

    void stream[Symbol.asyncIterator]()
      .next()
      .catch(() => {});
    expect(loaded).toBe(true);
  });
});
