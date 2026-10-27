import { afterEach, describe, expect, test } from "bun:test";
import type {
  DiagnosticsResult,
  FileListResult,
  FileReadResult,
  GitChangesResult,
  GitDiffResult,
} from "@cc-web/protocol";
import {
  compositeId,
  fetchChanges,
  fetchDiagnostics,
  fetchDiff,
  listFiles,
  readFile,
} from "./inspect-api.ts";

/**
 * The inspection surface's HTTP half (§17.1, §23 §10).
 *
 * Pure mapping, like `runs-api.ts`: which status collapses into which
 * operator-facing outcome is decided here so a panel never parses a body meant
 * for a person. Known runner codes become Vietnamese copy — the UI is
 * Vietnamese — and an unknown code keeps the server's own message.
 */

type Captured = { url: string; method: string };

const realFetch = globalThis.fetch;

function capture(status: number, body: unknown, options: { json?: boolean } = {}): Captured {
  const captured = { url: "", method: "" } as Captured;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input);
    captured.method = init?.method ?? "GET";
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

const fileList: FileListResult = {
  op: "file.list",
  path: "",
  entries: [{ name: "README.md", kind: "file", size: 12 }],
  truncated: false,
};

const fileRead: FileReadResult = {
  op: "file.read",
  path: "a.ts",
  content: "export {};\n",
  binary: false,
  truncated: false,
  hash: "abc",
  size: 11,
};

const changes: GitChangesResult = {
  op: "git.changes",
  entries: [{ path: "a.ts", status: "modified" }],
  truncated: false,
};

const diff: GitDiffResult = { op: "git.diff", path: "a.ts", diff: "+x\n", truncated: false };

const diagnostics: DiagnosticsResult = {
  op: "diagnostics",
  report: {
    protocolVersion: 1,
    runtime: "bun 1.4.3",
    workspaceRoot: "/srv/proj",
    sources: [{ source: "user", path: "~/.claude/settings.json", exists: true, readable: true }],
    gitAvailable: true,
    providerAuth: "configured",
    warnings: [],
  },
};

describe("compositeId", () => {
  test("forms one URL segment from both halves", () => {
    expect(compositeId("r-1", "default")).toBe("r-1%2Fdefault");
    // Both halves are encoded as part of the whole: the server decodes once,
    // then splits on the first literal slash (T9's parseCompositeId).
    expect(compositeId("r 1", "ws/2")).toBe("r%201%2Fws%2F2");
  });
});

describe("inspect calls", () => {
  test("lists a directory and returns the parsed result", async () => {
    const captured = capture(200, fileList);

    const outcome = await listFiles("r-1%2Fdefault", "src");

    expect(outcome).toEqual({ ok: true, value: fileList });
    expect(captured.method).toBe("GET");
    // The id is already one encoded segment (a `compositeId` result) and the
    // path is a query value, so both survive the round trip.
    expect(captured.url).toBe("/api/workspaces/r-1%2Fdefault/files?path=src");
  });

  test("reads a file and encodes a nested path", async () => {
    const captured = capture(200, fileRead);

    const outcome = await readFile("r-1%2Fdefault", "src/app.ts");

    expect(outcome).toEqual({ ok: true, value: fileRead });
    expect(captured.url).toBe("/api/workspaces/r-1%2Fdefault/file?path=src%2Fapp.ts");
  });

  test("fetches changes without a path", async () => {
    const captured = capture(200, changes);

    const outcome = await fetchChanges("r-1%2Fdefault");

    expect(outcome).toEqual({ ok: true, value: changes });
    expect(captured.url).toBe("/api/workspaces/r-1%2Fdefault/changes");
  });

  test("fetches a diff for one path", async () => {
    const captured = capture(200, diff);

    const outcome = await fetchDiff("r-1%2Fdefault", "a.ts");

    expect(outcome).toEqual({ ok: true, value: diff });
    expect(captured.url).toBe("/api/workspaces/r-1%2Fdefault/diff?path=a.ts");
  });

  test("fetches the diagnostics report", async () => {
    const captured = capture(200, diagnostics);

    const outcome = await fetchDiagnostics("r-1%2Fdefault");

    expect(outcome).toEqual({ ok: true, value: diagnostics });
    expect(captured.url).toBe("/api/workspaces/r-1%2Fdefault/config/diagnostics");
  });

  test("maps a known ApiError code to Vietnamese copy", async () => {
    capture(400, {
      error: { code: "PATH_OUTSIDE_WORKSPACE", message: "outside", retryable: false },
      requestId: "req-1",
    });

    const outcome = await listFiles("r-1%2Fdefault", "../x");

    expect(outcome).toEqual({
      ok: false,
      code: "PATH_OUTSIDE_WORKSPACE",
      message: "Đường dẫn nằm ngoài workspace.",
    });
  });

  test("keeps the server's message for a code the UI does not know", async () => {
    capture(502, {
      error: { code: "SOMETHING_NEW", message: "runner said no", retryable: true },
      requestId: "req-1",
    });

    const outcome = await fetchChanges("r-1%2Fdefault");

    expect(outcome).toEqual({ ok: false, code: "SOMETHING_NEW", message: "runner said no" });
  });

  test("a non-JSON failure becomes a generic outcome, never a thrown parse", async () => {
    capture(503, "service unavailable", { json: false });

    const outcome = await fetchDiagnostics("r-1%2Fdefault");

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

    const outcome = await listFiles("r-1%2Fdefault", "");

    expect(outcome).toEqual({
      ok: false,
      code: "error",
      message: "Không kết nối được máy chủ.",
    });
  });
});
