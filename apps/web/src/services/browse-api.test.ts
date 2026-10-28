import { afterEach, describe, expect, test } from "bun:test";
import type { FsBrowseResult } from "@cc-web/protocol";
import { compositeId, fetchDirectory, registerWorkspace } from "./browse-api.ts";

/**
 * The workspace discovery surface's HTTP half (§23, Task 10).
 *
 * Two calls:
 * - `fetchDirectory` forwards a `workspace.fs.browse` question to the runner that
 *   owns the runner id and answers with its `FsBrowseResult`.
 * - `registerWorkspace` POSTs a chosen path under a runner so the owner can name
 *   it by a stable composite id, and answers 201 with the minted pair.
 *
 * Both follow the never-throw spine of inspect-api: a network/parse failure is a
 * generic outcome, and known runner codes collapse to Vietnamese copy.
 */

type Captured = { url: string; method: string; body: string; contentType: string };

const realFetch = globalThis.fetch;

function capture(status: number, body: unknown, options: { json?: boolean } = {}): Captured {
  const captured = { url: "", method: "", body: "", contentType: "" } as Captured;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input);
    captured.method = init?.method ?? "GET";
    captured.body = init?.body ? String(init.body) : "";
    captured.contentType = init?.headers
      ? Array.isArray(init.headers)
        ? ""
        : (new Headers(init.headers).get("Content-Type") ?? "")
      : "";
    const text = options.json === false ? String(body) : JSON.stringify(body);
    return new Response(text, {
      status,
      headers: { "Content-Type": options.json === false ? "text/plain" : "application/json" },
    });
  }) as typeof fetch;
  return captured;
}

afterEach(() => {
  // bun runs every test file in one process: a leaked stub would answer the
  // next file's real fetches with this test's canned status.
  globalThis.fetch = realFetch;
});

const browseResult: FsBrowseResult = {
  op: "fs.browse",
  currentPath: "/srv/proj",
  parentPath: "/",
  shortcuts: [{ label: "~", path: "/root" }],
  entries: [
    {
      name: "README.md",
      path: "README.md",
      isDir: false,
      isGitRepo: false,
      hasClaudeProject: false,
    },
  ],
  truncated: false,
};

describe("compositeId", () => {
  test("forms one URL segment from both halves", () => {
    expect(compositeId("r-1", "default")).toBe("r-1%2Fdefault");
    expect(compositeId("r 1", "ws/2")).toBe("r%201%2Fws%2F2");
  });
});

describe("fetchDirectory", () => {
  test("browses a runner and returns the parsed result", async () => {
    const captured = capture(200, browseResult);

    const outcome = await fetchDirectory("runner-a", "src");

    expect(outcome).toEqual({ ok: true, value: browseResult });
    expect(captured.method).toBe("GET");
    expect(captured.url).toBe("/api/runners/runner-a/browse?path=src");
  });

  test("the bare path is requested when path is omitted", async () => {
    const captured = capture(200, browseResult);

    await fetchDirectory("runner-a");

    expect(captured.url).toBe("/api/runners/runner-a/browse?path=");
  });

  test("a nested path is URL-encoded in the query", async () => {
    const captured = capture(200, browseResult);

    await fetchDirectory("runner-a", "packages/web");

    expect(captured.url).toBe("/api/runners/runner-a/browse?path=packages%2Fweb");
  });

  test("maps a known runner code to Vietnamese copy", async () => {
    capture(404, {
      error: {
        code: "RUNNER_NOT_FOUND",
        message: "runner not found",
        retryable: false,
        details: undefined,
      },
      requestId: "req-1",
    });

    const outcome = await fetchDirectory("runner-a", "src");

    expect(outcome).toEqual({
      ok: false,
      code: "RUNNER_NOT_FOUND",
      message: "Runner không sẵn sàng.",
    });
  });

  test("keeps the runner's own message for a code the UI does not know", async () => {
    capture(502, {
      error: {
        code: "PATH_OUTSIDE_WORKSPACE",
        message: "path outside",
        retryable: false,
        details: undefined,
      },
      requestId: "req-1",
    });

    const outcome = await fetchDirectory("runner-a", "../x");

    expect(outcome).toEqual({
      ok: false,
      code: "PATH_OUTSIDE_WORKSPACE",
      message: "Đường dẫn nằm ngoài workspace.",
    });
  });

  test("a non-JSON failure becomes a generic outcome, never a thrown parse", async () => {
    capture(503, "service unavailable", { json: false });

    const outcome = await fetchDirectory("runner-a", "src");

    expect(outcome).toEqual({
      ok: false,
      code: "error",
      message: "Không kết nối được máy chủ.",
    });
  });

  test("a network failure maps to a generic outcome", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const outcome = await fetchDirectory("runner-a", "src");

    expect(outcome).toEqual({
      ok: false,
      code: "error",
      message: "Không kết nối được máy chủ.",
    });
  });
});

describe("registerWorkspace", () => {
  test("registers a path and answers 201 with the workspace id", async () => {
    const captured = capture(201, {
      workspaceId: "ws-1",
      path: "/srv/custom",
      runnerId: "runner-a",
    });

    const outcome = await registerWorkspace("runner-a", "/srv/custom");

    expect(outcome).toEqual({
      ok: true,
      value: { workspaceId: "ws-1", path: "/srv/custom", runnerId: "runner-a" },
    });
    expect(captured.method).toBe("POST");
    expect(captured.url).toBe("/api/runners/runner-a/workspaces");
    expect(JSON.parse(captured.body)).toEqual({ path: "/srv/custom" });
    expect(captured.contentType).toBe("application/json");
  });

  test("forwards a client-supplied workspaceId in the body", async () => {
    const captured = capture(201, {
      workspaceId: "my-ws",
      path: "/srv/custom",
      runnerId: "runner-a",
    });

    await registerWorkspace("runner-a", "/srv/custom", "my-ws");

    expect(JSON.parse(captured.body)).toEqual({ path: "/srv/custom", workspaceId: "my-ws" });
  });

  test("a 404 runner collapses to Vietnamese copy", async () => {
    capture(404, {
      error: {
        code: "RUNNER_NOT_FOUND",
        message: "runner not found",
        retryable: false,
        details: undefined,
      },
      requestId: "req-1",
    });

    const outcome = await registerWorkspace("runner-a", "/srv/custom");

    expect(outcome).toEqual({
      ok: false,
      code: "RUNNER_NOT_FOUND",
      message: "Runner không sẵn sàng.",
    });
  });

  test("a non-JSON failure becomes a generic outcome", async () => {
    capture(500, "boom", { json: false });

    const outcome = await registerWorkspace("runner-a", "/srv/custom");

    expect(outcome).toEqual({
      ok: false,
      code: "error",
      message: "Không kết nối được máy chủ.",
    });
  });

  test("a network failure maps to a generic outcome", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const outcome = await registerWorkspace("runner-a", "/srv/custom");

    expect(outcome).toEqual({
      ok: false,
      code: "error",
      message: "Không kết nối được máy chủ.",
    });
  });
});
