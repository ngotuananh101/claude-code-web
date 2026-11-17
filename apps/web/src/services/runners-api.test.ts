import { afterEach, describe, expect, test } from "bun:test";
import { runnerNames } from "../stores/runner-names.ts";
import {
  deleteRunner,
  fetchRunners,
  liveRunners,
  modelsOfRunner,
  renameRunner,
} from "./runners-api.ts";

/**
 * The runner registry's HTTP half (§6.1, §5.2): the rows the composer's picker
 * is built from, and the fallback rules that keep a runner with no advertised
 * models from emptying the list.
 */

const realFetch = globalThis.fetch;
const previousNames = new Map(runnerNames);

afterEach(() => {
  runnerNames.clear();
  for (const [id, name] of previousNames) runnerNames.set(id, name);
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

  test("publishes runner names for the rail and removes absent registry entries", async () => {
    runnerNames.set("runner-gone", "Old connector");
    globalThis.fetch = (async () =>
      Response.json({
        runners: [
          { runnerId: "runner-a", name: "Workstation", revokedAt: null, models: [] },
          { runnerId: "runner-b", revokedAt: null, models: [] },
        ],
      })) as unknown as typeof fetch;
    await fetchRunners();
    expect([...runnerNames]).toEqual([
      ["runner-a", "Workstation"],
      ["runner-b", null],
    ]);
  });

  test("a failed listing does not discard the current display names", async () => {
    runnerNames.set("runner-a", "Workstation");
    globalThis.fetch = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await fetchRunners();
    expect(runnerNames.get("runner-a")).toBe("Workstation");
  });

  test("a listing started before a rename cannot overwrite the new sidebar name", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PATCH" ? Response.json({ ok: true }) : pending) as typeof fetch;
    const listing = fetchRunners();
    await renameRunner("r-1", "New name");
    release(
      Response.json({
        runners: [{ runnerId: "r-1", name: "Old name", revokedAt: null, models: [] }],
      }),
    );
    await listing;
    expect(runnerNames.get("r-1")).toBe("New name");
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

describe("renameRunner", () => {
  test("sends PATCH /api/runners/:id with name in body", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? "GET";
      capturedBody = init?.body ? String(init.body) : "";
      return new Response(JSON.stringify({ ok: true, runnerId: "r-1", name: "Runner 1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const ok = await renameRunner("r-1", "Runner 1");
    expect(capturedUrl).toBe("/api/runners/r-1");
    expect(capturedMethod).toBe("PATCH");
    expect(JSON.parse(capturedBody)).toEqual({ name: "Runner 1" });
    expect(ok).toBe(true);
  });

  test("publishes a successful rename immediately to sidebar consumers", async () => {
    runnerNames.set("r-1", "Old name");
    globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
    expect(await renameRunner("r-1", "  New name  ")).toBe(true);
    expect(runnerNames.get("r-1")).toBe("New name");
    expect(await renameRunner("r-1", "  ")).toBe(true);
    expect(runnerNames.get("r-1")).toBeNull();
  });

  test("a rejected rename keeps the existing sidebar name", async () => {
    runnerNames.set("r-1", "Old name");
    globalThis.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await renameRunner("r-1", "New name")).toBe(false);
    expect(runnerNames.get("r-1")).toBe("Old name");
  });

  test("returns false on error", async () => {
    globalThis.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const ok = await renameRunner("r-1", "Runner 1");
    expect(ok).toBe(false);
  });
});

describe("deleteRunner", () => {
  test("sends DELETE /api/runners/:id and returns result", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? "GET";
      return new Response(JSON.stringify({ ok: true, runnerId: "r-1", deletedSessions: ["s-1"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const res = await deleteRunner("r-1");
    expect(capturedUrl).toBe("/api/runners/r-1");
    expect(capturedMethod).toBe("DELETE");
    expect(res).toEqual({ ok: true, runnerId: "r-1", deletedSessions: ["s-1"] });
  });

  test("returns ok false on error", async () => {
    globalThis.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const res = await deleteRunner("r-unknown");
    expect(res).toEqual({ ok: false });
  });
});
