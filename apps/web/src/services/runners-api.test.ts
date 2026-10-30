import { afterEach, describe, expect, test } from "bun:test";
import { fetchRunners, liveRunners, modelsOfRunner } from "./runners-api.ts";

/**
 * The runner registry's HTTP half (§6.1, §5.2): the rows the composer's picker
 * is built from, and the fallback rules that keep a runner with no advertised
 * models from emptying the list.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  // bun runs every test file in one process: a leaked stub would answer the
  // next file's real fetches with this test's canned status.
  globalThis.fetch = realFetch;
});

const advertised = [
  {
    value: "pro",
    displayName: "pro",
    description: "Custom Opus model",
    supportsEffort: true,
    supportedEffortLevels: ["low" as const, "max" as const],
  },
];

describe("fetchRunners", () => {
  test("a 200 answers every runner with its advertised models, requested with GET", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? "GET";
      return new Response(
        JSON.stringify({
          runners: [
            { runnerId: "runner-a", revokedAt: null, models: advertised },
            { runnerId: "runner-b", revokedAt: 123, models: [] },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await fetchRunners();

    expect(capturedUrl).toBe("/api/runners");
    expect(capturedMethod).toBe("GET");
    expect(result).toEqual({
      ok: true,
      runners: [
        { runnerId: "runner-a", revokedAt: null, models: advertised },
        { runnerId: "runner-b", revokedAt: 123, models: [] },
      ],
    });
  });

  test("401 collapses to unauthorized", async () => {
    globalThis.fetch = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    expect(await fetchRunners()).toEqual({ ok: false, reason: "unauthorized" });
  });

  test("a network failure and a 500 both collapse to error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchRunners()).toEqual({ ok: false, reason: "error" });

    globalThis.fetch = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchRunners()).toEqual({ ok: false, reason: "error" });
  });
});

describe("liveRunners / modelsOfRunner", () => {
  const runners = [
    { runnerId: "runner-a", revokedAt: null, models: advertised },
    { runnerId: "runner-b", revokedAt: 123, models: [] },
  ];

  test("drops revoked runners", () => {
    expect(liveRunners(runners).map((runner) => runner.runnerId)).toEqual(["runner-a"]);
  });

  test("answers a runner's models, or an empty list for an unknown one", () => {
    expect(modelsOfRunner(runners, "runner-a")).toEqual(advertised);
    expect(modelsOfRunner(runners, "runner-b")).toEqual([]);
    expect(modelsOfRunner(runners, "runner-gone")).toEqual([]);
  });
});
