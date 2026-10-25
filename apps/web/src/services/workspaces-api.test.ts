import { afterEach, describe, expect, test } from "bun:test";
import { fetchWorkspaces } from "./workspaces-api.ts";

/**
 * The workspace registry's HTTP half (§15.1), decided here and nowhere in a
 * component: which statuses collapse into which operator-facing outcome, and
 * the exact row shape the composer filters on.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  // bun runs every test file in one process: a leaked stub would answer the
  // next file's real fetches with this test's canned status.
  globalThis.fetch = realFetch;
});

describe("fetchWorkspaces", () => {
  test("a 200 answers the declared workspaces, requested with GET", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? "GET";
      return new Response(
        JSON.stringify({
          workspaces: [
            { workspaceId: "default", runnerId: "runner-a", path: "/srv/proj", createdAt: 1 },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await fetchWorkspaces();

    expect(capturedUrl).toBe("/api/workspaces");
    expect(capturedMethod).toBe("GET");
    expect(result).toEqual({
      ok: true,
      workspaces: [
        { workspaceId: "default", runnerId: "runner-a", path: "/srv/proj", createdAt: 1 },
      ],
    });
  });

  test("401 collapses to unauthorized", async () => {
    globalThis.fetch = (async () =>
      new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

    expect(await fetchWorkspaces()).toEqual({ ok: false, reason: "unauthorized" });
  });

  test("any other non-OK status collapses to error, and so does a network failure", async () => {
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchWorkspaces()).toEqual({ ok: false, reason: "error" });

    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    expect(await fetchWorkspaces()).toEqual({ ok: false, reason: "error" });
  });
});
