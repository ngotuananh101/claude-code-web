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
  fetchSnapshotStatus,
  listFiles,
  readFile,
  revertFile,
  revertWorkspace,
  writeFile,
} from "./inspect-api.ts";

/**
 * The inspection surface's HTTP half (§17.1, §23 §10).
 *
 * Pure mapping, like `runs-api.ts`: which status collapses into which
 * operator-facing outcome is decided here so a panel never parses a body meant
 * for a person. Known runner codes become Vietnamese copy — the UI is
 * Vietnamese — and an unknown code keeps the server's own message.
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

  test("saves with PUT, a JSON body and the path in the query", async () => {
    const captured = capture(200, { op: "file.write", path: "a.txt", hash: "h2", size: 5 });
    const outcome = await writeFile("r-1%2Fdefault", "src/a.ts", "next\n", "h1");
    expect(outcome).toEqual({
      ok: true,
      value: { op: "file.write", path: "a.txt", hash: "h2", size: 5 },
    });
    expect(captured.url).toBe("/api/workspaces/r-1%2Fdefault/file?path=src%2Fa.ts");
    expect(captured.method).toBe("PUT");
    expect(JSON.parse(captured.body)).toEqual({ content: "next\n", expectedHash: "h1" });
    expect(captured.contentType).toBe("application/json");
  });

  test("reverts one file with POST and an explicit null token", async () => {
    const captured = capture(200, {
      op: "file.revert",
      path: "new.ts",
      action: "deleted",
      hash: null,
      size: null,
    });
    await revertFile("r-1%2Fdefault", "new.ts", null);
    expect(captured.url).toBe("/api/workspaces/r-1%2Fdefault/file/revert");
    expect(captured.method).toBe("POST");
    expect(JSON.parse(captured.body)).toEqual({ path: "new.ts", expectedHash: null });
  });

  test("applies a workspace revert with the plan digest", async () => {
    const captured = capture(200, {
      op: "workspace.revert",
      planDigest: "d1",
      restored: 1,
      deleted: 0,
      failed: null,
    });
    await revertWorkspace("r-1%2Fdefault", "d1");
    expect(captured.url).toBe("/api/workspaces/r-1%2Fdefault/revert");
    expect(JSON.parse(captured.body)).toEqual({ planDigest: "d1" });
  });

  test("fetches the snapshot status", async () => {
    const captured = capture(200, {
      op: "snapshot.status",
      baseline: null,
      entries: [],
      counts: { modified: 0, created: 0, deleted: 0, excluded: 0 },
      digest: null,
      truncated: false,
    });
    await fetchSnapshotStatus("r-1%2Fdefault");
    expect(captured.url).toBe("/api/workspaces/r-1%2Fdefault/snapshot");
  });

  test("maps REVERT_STALE to Vietnamese copy", async () => {
    capture(409, {
      error: { code: "REVERT_STALE", message: "stale", retryable: false },
      requestId: "r",
    });
    const outcome = await revertWorkspace("r-1%2Fdefault", "d1");
    expect(outcome).toEqual({
      ok: false,
      code: "REVERT_STALE",
      message: "Kế hoạch khôi phục đã cũ — hãy xem lại.",
    });
  });
});
