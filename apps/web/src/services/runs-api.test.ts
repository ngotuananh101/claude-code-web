import { afterEach, describe, expect, test } from "bun:test";
import { cancelRun, startRun } from "./runs-api.ts";

/**
 * The run surface's HTTP half (§17.1), decided here and nowhere in a
 * component: which statuses collapse into which operator-facing outcome, and
 * that the prompt only ever travels in the body — never a URL (§19.4).
 */

type Captured = { url: string; method: string; body: unknown; init: RequestInit | undefined };

const realFetch = globalThis.fetch;

function capture(status: number, body: unknown = {}): Captured {
  const captured = { url: "", method: "", body: undefined, init: undefined } as Captured;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input);
    captured.method = init?.method ?? "GET";
    captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    captured.init = init;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return captured;
}

afterEach(() => {
  // bun runs every test file in one process: a leaked stub would answer the
  // next file's real fetches with this test's canned status.
  globalThis.fetch = realFetch;
});

describe("startRun", () => {
  test("a 202 answers ok with the ids the journal will use", async () => {
    const captured = capture(202, {
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      runnerId: "runner-a",
    });

    const result = await startRun("session-1", "hello");

    expect(result).toEqual({
      ok: true,
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
    });
    expect(captured.method).toBe("POST");
    expect(captured.url).toBe("/api/sessions/session-1/runs");
    expect(captured.body).toEqual({ prompt: "hello" });
  });

  test("the session id is URL-encoded, the prompt never is", async () => {
    const captured = capture(202, { runId: "r", attemptId: "a", sessionId: "s" });

    await startRun("session /ß", "hello");

    expect(captured.url).toBe("/api/sessions/session%20%2F%C3%9F/runs");
  });

  test("a workspaceId travels in the body; without one the body stays prompt-only", async () => {
    const withWorkspace = capture(202, { runId: "r", attemptId: "a", sessionId: "s" });
    await startRun("session-1", "hello", "proj-x");
    expect(withWorkspace.body).toEqual({ prompt: "hello", workspaceId: "proj-x" });

    const withoutWorkspace = capture(202, { runId: "r", attemptId: "a", sessionId: "s" });
    await startRun("session-1", "hello");
    expect(withoutWorkspace.body).toEqual({ prompt: "hello" });
  });

  test("409 collapses to session_busy", async () => {
    capture(409, "session_busy");
    expect((await startRun("s", "p")).ok).toBe(false);
    expect(await startRun("s", "p")).toEqual({ ok: false, reason: "session_busy" });
  });

  test("503 collapses to runner_unavailable", async () => {
    capture(503, "runner_offline");
    expect(await startRun("s", "p")).toEqual({ ok: false, reason: "runner_unavailable" });
  });

  test("401 collapses to unauthorized", async () => {
    capture(401, "unauthorized");
    expect(await startRun("s", "p")).toEqual({ ok: false, reason: "unauthorized" });
  });

  test("anything else is a plain error, and so is a network failure", async () => {
    capture(500, "boom");
    expect(await startRun("s", "p")).toEqual({ ok: false, reason: "error" });

    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    expect(await startRun("s", "p")).toEqual({ ok: false, reason: "error" });
  });
});

describe("cancelRun", () => {
  test("a 202 is accepted", async () => {
    const captured = capture(202, { runId: "run-1", commandId: "cmd-1" });

    const outcome = await cancelRun("run-1");

    expect(outcome).toBe("accepted");
    expect(captured.method).toBe("POST");
    expect(captured.url).toBe("/api/runs/run-1/cancel");
  });

  test("404 is not_found, 401 is unauthorized, the rest are errors", async () => {
    capture(404, "not found");
    expect(await cancelRun("run-1")).toBe("not_found");

    capture(401, "unauthorized");
    expect(await cancelRun("run-1")).toBe("unauthorized");

    capture(500, "boom");
    expect(await cancelRun("run-1")).toBe("error");
  });
});
