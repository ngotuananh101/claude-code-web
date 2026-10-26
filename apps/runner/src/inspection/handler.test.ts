import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FILE_BYTES, MAX_LISTING_ENTRIES } from "@cc-web/protocol";
import type { GitSpawn } from "../git/spawn.ts";
import { createInspectHandler } from "./handler.ts";

/**
 * The inspection handler (§23, rulings 6, 8, 9, 11).
 *
 * Two things the tests exist to hold down: a read-only question never takes the
 * workspace lock and never creates an attempt (there is no database here at
 * all, which is the structural proof), and every failure is a coded refusal
 * rather than a throw, because the frame is the only channel the server has.
 */

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cc-web-inspect-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function scriptedSpawn(script: Array<{ exitCode: number; stdout: string }>): GitSpawn & {
  calls: Array<[readonly string[], string]>;
} {
  const calls: Array<[readonly string[], string]> = [];
  const spawn = (async (argv: readonly string[], cwd: string) => {
    calls.push([argv, cwd]);
    return script[calls.length - 1] ?? { exitCode: 0, stdout: "" };
  }) as GitSpawn & { calls: Array<[readonly string[], string]> };
  spawn.calls = calls;
  return spawn;
}

function command(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    commandId: "cmd-1",
    runnerId: "runner-a",
    workspaceId: "default",
    kind: "workspace.inspect",
    issuedAt: "2026-10-26T00:00:00.000Z",
    payload: { op: "file.list", path: "" },
    ...overrides,
  };
}

async function setUp(
  files: Record<string, string> = {},
  options: { spawn?: GitSpawn; mkdirs?: string[] } = {},
): Promise<{ root: string; handler: (c: unknown) => Promise<unknown> }> {
  const root = await makeRoot();
  for (const name of options.mkdirs ?? ["sub"]) await mkdir(join(root, name), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content);
  }
  const handler = createInspectHandler({
    workspacePathFor: (workspaceId) => (workspaceId === "default" ? root : undefined),
    spawn: options.spawn ?? (async () => ({ exitCode: 0, stdout: "" })),
    now: () => Date.parse("2026-10-26T00:00:00.000Z"),
    homeDir: root,
    env: {},
  });
  return { root, handler };
}

describe("file.list", () => {
  test("answers with typed entries, directories distinguished", async () => {
    const { handler } = await setUp({ "a.txt": "hello\n" });

    const frame = (await handler(command({ payload: { op: "file.list", path: "" } }))) as Record<
      string,
      unknown
    >;
    expect(frame).toMatchObject({
      ok: true,
      result: { op: "file.list", path: "", truncated: false },
    });
    const result = frame["result"] as {
      entries: Array<{ name: string; kind: string; size: number }>;
    };
    expect(result.entries.map((e) => e.name).sort()).toEqual(["a.txt", "sub"]);
    expect(result.entries.find((e) => e.name === "sub")?.kind).toBe("directory");
    expect(result.entries.find((e) => e.name === "a.txt")?.kind).toBe("file");
    expect(result.entries.find((e) => e.name === "a.txt")?.size).toBe(6);
  });

  test("lists a credential file by name while refusing its content", async () => {
    const { handler } = await setUp({ ".env": "SECRET=1\n", "a.txt": "hello\n" });

    const listing = (await handler(command({ payload: { op: "file.list", path: "" } }))) as {
      result: { entries: Array<{ name: string }> };
    };
    expect(listing.result.entries.some((e) => e.name === ".env")).toBe(true);

    const read = (await handler(command({ payload: { op: "file.read", path: ".env" } }))) as Record<
      string,
      unknown
    >;
    expect(read).toMatchObject({ ok: false, error: { code: "CREDENTIAL_FILE_REFUSED" } });
  });

  test("truncates a listing past the entry bound", async () => {
    const dirs = Array.from(
      { length: MAX_LISTING_ENTRIES + 5 },
      (_, i) => `d${String(i).padStart(5, "0")}`,
    );
    const { handler } = await setUp({}, { mkdirs: dirs });

    const frame = (await handler(command({ payload: { op: "file.list", path: "" } }))) as {
      result: { entries: unknown[]; truncated: boolean };
    };
    expect(frame.result.entries.length).toBe(MAX_LISTING_ENTRIES);
    expect(frame.result.truncated).toBe(true);
  });

  test("refuses listing a file as if it were a directory", async () => {
    const { handler } = await setUp({ "a.txt": "hello\n" });

    const frame = (await handler(
      command({ payload: { op: "file.list", path: "a.txt" } }),
    )) as Record<string, unknown>;
    expect(frame).toMatchObject({ ok: false, error: { code: "NOT_A_DIRECTORY" } });
  });
});

describe("file.read", () => {
  test("answers with content, a sha-256 hash and the size", async () => {
    const { handler } = await setUp({ "a.txt": "hello\n" });

    const frame = (await handler(
      command({ payload: { op: "file.read", path: "a.txt" } }),
    )) as Record<string, unknown>;
    expect(frame).toMatchObject({
      ok: true,
      result: { op: "file.read", content: "hello\n", binary: false, truncated: false, size: 6 },
    });
    const result = frame["result"] as { hash: string };
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("returns the same hash for the same bytes (content-addressed)", async () => {
    const { handler } = await setUp({ "a.txt": "hello\n", "b.txt": "hello\n" });

    const first = (await handler(command({ payload: { op: "file.read", path: "a.txt" } }))) as {
      result: { hash: string };
    };
    const second = (await handler(command({ payload: { op: "file.read", path: "b.txt" } }))) as {
      result: { hash: string };
    };
    expect(first.result.hash).toBe(second.result.hash);
  });

  test("flags a binary file and returns null content", async () => {
    const { root, handler } = await setUp();
    await writeFile(join(root, "bin.dat"), Buffer.from([0x61, 0x00, 0x62]));

    const frame = (await handler(command({ payload: { op: "file.read", path: "bin.dat" } }))) as {
      result: { binary: boolean; content: string | null };
    };
    expect(frame.result.binary).toBe(true);
    expect(frame.result.content).toBeNull();
  });

  test("truncates a file past the byte bound", async () => {
    const { root, handler } = await setUp();
    await writeFile(join(root, "big.txt"), "a".repeat(MAX_FILE_BYTES + 100));

    const frame = (await handler(command({ payload: { op: "file.read", path: "big.txt" } }))) as {
      result: { content: string; truncated: boolean };
    };
    expect(frame.result.truncated).toBe(true);
    expect(Buffer.byteLength(frame.result.content, "utf8")).toBe(MAX_FILE_BYTES);
  });

  test("refuses a path outside the workspace with a code", async () => {
    const { handler } = await setUp();

    const frame = (await handler(
      command({ payload: { op: "file.read", path: "../x" } }),
    )) as Record<string, unknown>;
    expect(frame).toMatchObject({ ok: false, error: { code: "PATH_OUTSIDE_WORKSPACE" } });
  });

  test("refuses reading a directory", async () => {
    const { handler } = await setUp();

    const frame = (await handler(command({ payload: { op: "file.read", path: "sub" } }))) as Record<
      string,
      unknown
    >;
    expect(frame).toMatchObject({ ok: false, error: { code: "NOT_A_FILE" } });
  });

  test("refuses an empty path for a read", async () => {
    const { handler } = await setUp();

    const frame = (await handler(command({ payload: { op: "file.read", path: "" } }))) as Record<
      string,
      unknown
    >;
    expect(frame).toMatchObject({ ok: false, error: { code: "NOT_A_FILE" } });
  });

  test("reports a missing file as FILE_NOT_FOUND", async () => {
    const { handler } = await setUp();

    const frame = (await handler(
      command({ payload: { op: "file.read", path: "nope.txt" } }),
    )) as Record<string, unknown>;
    expect(frame).toMatchObject({ ok: false, error: { code: "FILE_NOT_FOUND" } });
  });
});

describe("git.changes", () => {
  test("answers via the spawner in the workspace cwd", async () => {
    const spawn = scriptedSpawn([{ exitCode: 0, stdout: " M a.ts\0" }]);
    const { root, handler } = await setUp({}, { spawn });

    const frame = (await handler(command({ payload: { op: "git.changes" } }))) as {
      result: { op: string; entries: unknown[]; truncated: boolean };
    };
    expect(frame.result).toMatchObject({ op: "git.changes", truncated: false });
    expect(frame.result.entries).toEqual([{ path: "a.ts", status: "modified" }]);
    expect(spawn.calls[0]?.[0]).toEqual(["git", "status", "--porcelain=v1", "-z"]);
    expect(spawn.calls[0]?.[1]).toBe(root);
  });

  test("refuses when git exits non-zero rather than reporting an empty tree", async () => {
    const spawn = scriptedSpawn([{ exitCode: 128, stdout: "" }]);
    const { handler } = await setUp({}, { spawn });

    const frame = (await handler(command({ payload: { op: "git.changes" } }))) as Record<
      string,
      unknown
    >;
    expect(frame).toMatchObject({ ok: false, error: { code: "FILE_UNREADABLE" } });
  });
});

describe("git.diff", () => {
  test("answers with the diff for one path", async () => {
    const spawn = scriptedSpawn([{ exitCode: 0, stdout: "--- a\n+++ b\n" }]);
    const { handler } = await setUp({ "a.ts": "x\n" }, { spawn });

    const frame = (await handler(command({ payload: { op: "git.diff", path: "a.ts" } }))) as {
      result: { op: string; diff: string; truncated: boolean };
    };
    expect(frame.result).toMatchObject({
      op: "git.diff",
      diff: "--- a\n+++ b\n",
      truncated: false,
    });
    expect(spawn.calls[0]?.[0]).toEqual(["git", "diff", "--", "a.ts"]);
  });

  test("differs a path that no longer exists, because a deletion is a change", async () => {
    const spawn = scriptedSpawn([{ exitCode: 0, stdout: "deleted\n" }]);
    const { handler } = await setUp({}, { spawn });

    const frame = (await handler(command({ payload: { op: "git.diff", path: "gone.ts" } }))) as {
      result: { op: string };
    };
    expect(frame.result.op).toBe("git.diff");
  });

  test("still refuses a traversal in a diff path", async () => {
    const { handler } = await setUp();

    const frame = (await handler(
      command({ payload: { op: "git.diff", path: "../etc/passwd" } }),
    )) as Record<string, unknown>;
    expect(frame).toMatchObject({ ok: false, error: { code: "PATH_OUTSIDE_WORKSPACE" } });
  });

  test("truncates a diff past the byte cap", async () => {
    const spawn = scriptedSpawn([{ exitCode: 0, stdout: "x".repeat(300 * 1024) }]);
    const { handler } = await setUp({}, { spawn });

    const frame = (await handler(command({ payload: { op: "git.diff", path: "a.ts" } }))) as {
      result: { diff: string; truncated: boolean };
    };
    expect(frame.result.truncated).toBe(true);
    expect(Buffer.byteLength(frame.result.diff, "utf8")).toBeLessThanOrEqual(256 * 1024);
  });
});

describe("diagnostics", () => {
  test("answers with a redacted report naming the workspace root", async () => {
    const { root, handler } = await setUp();

    const frame = (await handler(
      command({ kind: "config.inspect", payload: { op: "diagnostics" } }),
    )) as { result: { op: string; report: Record<string, unknown> } };
    expect(frame.result.op).toBe("diagnostics");
    expect(frame.result.report["workspaceRoot"]).toBe(root);
    expect(frame.result.report["sources"]).toEqual([
      expect.objectContaining({ source: "user" }),
      expect.objectContaining({ source: "project" }),
      expect.objectContaining({ source: "local" }),
    ]);
    expect(frame.result.report["warnings"]).toEqual([]);
  });

  test("never carries a credential value, only presence", async () => {
    const root = await makeRoot();
    roots.push(root);
    const handler = createInspectHandler({
      workspacePathFor: () => root,
      spawn: async () => ({ exitCode: 0, stdout: "" }),
      homeDir: root,
      env: { ANTHROPIC_API_KEY: "sk-ant-api03-SecretValue123456" },
    });

    const frame = (await handler(
      command({ kind: "config.inspect", payload: { op: "diagnostics" } }),
    )) as { result: { report: Record<string, unknown> } };
    const serialized = JSON.stringify(frame);
    expect(serialized).not.toContain("SecretValue");
    expect(frame.result.report["providerAuth"]).toBe("configured");
  });

  test("reports provider auth missing when nothing is set and no credential file exists", async () => {
    const { handler } = await setUp();

    const frame = (await handler(
      command({ kind: "config.inspect", payload: { op: "diagnostics" } }),
    )) as { result: { report: Record<string, unknown> } };
    expect(frame.result.report["providerAuth"]).toBe("missing");
  });
});

describe("refusals", () => {
  test("refuses an unknown workspace instead of guessing a path", async () => {
    const { handler } = await setUp();

    const frame = (await handler(
      command({ workspaceId: "nope", payload: { op: "git.changes" } }),
    )) as Record<string, unknown>;
    expect(frame).toMatchObject({ ok: false, error: { code: "WORKSPACE_NOT_FOUND" } });
  });

  test("refuses a malformed payload", async () => {
    const { handler } = await setUp();

    const frame = (await handler(command({ payload: { op: "nope" } }))) as Record<string, unknown>;
    expect(frame).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_COMMAND" } });
  });

  test("refuses an unreadable workspace root", async () => {
    const root = await makeRoot();
    roots.push(root);
    await rm(root, { recursive: true, force: true });
    const handler = createInspectHandler({
      workspacePathFor: () => root,
      spawn: async () => ({ exitCode: 0, stdout: "" }),
    });

    const frame = (await handler(command({ payload: { op: "file.list", path: "" } }))) as Record<
      string,
      unknown
    >;
    expect(frame).toMatchObject({ ok: false, error: { code: "FILE_NOT_FOUND" } });
  });

  test("echoes the command id on every frame so the waiter can match it", async () => {
    const { handler } = await setUp({ "a.txt": "x\n" });

    const good = (await handler(
      command({ commandId: "cmd-ok", payload: { op: "file.read", path: "a.txt" } }),
    )) as Record<string, unknown>;
    const bad = (await handler(
      command({ commandId: "cmd-bad", payload: { op: "file.read", path: "../x" } }),
    )) as Record<string, unknown>;
    expect(good["commandId"]).toBe("cmd-ok");
    expect(bad["commandId"]).toBe("cmd-bad");
    expect(good["type"]).toBe("rpc.result");
  });

  test("redacts secret-shaped text from a refusal message", async () => {
    const spawn = scriptedSpawn([{ exitCode: 128, stdout: "" }]);
    // A spawner that throws a message quoting a token: the refusal must not
    // carry it into the frame.
    const throwing: GitSpawn = async () => {
      throw new Error("git failed with ANTHROPIC_API_KEY=sk-ant-api03-LeakMe123456789");
    };
    const { handler } = await setUp({}, { spawn: throwing });

    const frame = (await handler(command({ payload: { op: "git.changes" } }))) as {
      error: { message: string };
    };
    expect(frame.error.message).not.toContain("sk-ant-api03-LeakMe123456789");
    expect(spawn.calls.length).toBe(0);
  });
});

describe("command shape", () => {
  test("answers a bare non-object command with a malformed refusal", async () => {
    const { handler } = await setUp();
    const frame = (await handler(null)) as Record<string, unknown>;
    expect(frame).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_COMMAND" } });
  });

  test("answers a non-object payload with a refusal rather than throwing", async () => {
    const { handler } = await setUp();
    const frame = (await handler(command({ payload: "file.read" }))) as Record<string, unknown>;
    expect(frame).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_COMMAND" } });
  });
});
