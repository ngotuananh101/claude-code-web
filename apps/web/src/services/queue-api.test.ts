import { afterEach, describe, expect, test } from "bun:test";
import { fetchSessionQueue } from "./queue-api.ts";

/**
 * The session queue read (§queue): returns the waiting runs in order and never
 * throws. Malformed rows are dropped rather than surfaced as blank entries so
 * the composer never renders a broken queue item.
 */

type Captured = { url: string; method: string };

const realFetch = globalThis.fetch;

function capture(status: number, body: unknown): Captured {
  const captured = { url: "", method: "" } as Captured;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input);
    captured.method = init?.method ?? "GET";
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

describe("fetchSessionQueue", () => {
  test("parses the queue and drops rows that are not display-shaped", async () => {
    // a malformed entry (missing runId, non-numeric enqueuedAt) is skipped, not rendered as blank
    const captured = capture(200, {
      runs: [
        { runId: "run-1", attemptId: "attempt-1", prompt: "first", enqueuedAt: 1000 },
        { attemptId: "attempt-missing-run", prompt: "no run id", enqueuedAt: 2000 },
        { runId: "run-nan", attemptId: "attempt-nan", prompt: "nan time", enqueuedAt: Number.NaN },
        { runId: "run-inf", attemptId: "attempt-inf", prompt: "inf time", enqueuedAt: Infinity },
        { runId: "run-str", attemptId: "attempt-str", prompt: "string time", enqueuedAt: "3000" },
        { runId: "run-no-attempt", prompt: "no attempt", enqueuedAt: 4000 },
        { runId: "run-no-prompt", attemptId: "attempt-no-prompt", enqueuedAt: 5000 },
        { runId: 123, attemptId: "attempt-bad-runid", prompt: "bad run id type", enqueuedAt: 6000 },
        { runId: "run-2", attemptId: "attempt-2", prompt: "second", enqueuedAt: 7000 },
        null,
        "garbage",
      ],
    });

    const result = await fetchSessionQueue("session-1");

    expect(result).toEqual({
      ok: true,
      runs: [
        { runId: "run-1", attemptId: "attempt-1", prompt: "first", enqueuedAt: 1000 },
        { runId: "run-2", attemptId: "attempt-2", prompt: "second", enqueuedAt: 7000 },
      ],
    });
    expect(captured.method).toBe("GET");
    expect(captured.url).toBe("/api/sessions/session-1/queue");
  });

  test("answers unauthorized on 401 and error on anything else", async () => {
    capture(401, "unauthorized");
    expect(await fetchSessionQueue("session-1")).toEqual({ ok: false, reason: "unauthorized" });

    capture(500, "boom");
    expect(await fetchSessionQueue("session-1")).toEqual({ ok: false, reason: "error" });

    capture(403, "forbidden");
    expect(await fetchSessionQueue("session-1")).toEqual({ ok: false, reason: "error" });

    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    expect(await fetchSessionQueue("session-1")).toEqual({ ok: false, reason: "error" });
  });

  test("URL-encodes the session id", async () => {
    const captured = capture(200, { runs: [] });
    await fetchSessionQueue("session /ß");
    expect(captured.url).toBe("/api/sessions/session%20%2F%C3%9F/queue");
  });
});
