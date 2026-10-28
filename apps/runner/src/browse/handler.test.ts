import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_BROWSE_ENTRIES } from "@cc-web/protocol";
import { createBrowseHandler } from "./handler.ts";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cc-web-browse-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function command(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    commandId: "cmd-1",
    runnerId: "runner-a",
    kind: "workspace.fs.browse",
    issuedAt: "2026-10-26T00:00:00.000Z",
    payload: {},
    ...overrides,
  };
}

describe("workspace.fs.browse", () => {
  test("defaults to homeDir when path is empty", async () => {
    const home = await makeRoot();
    await mkdir(join(home, "a"));
    await writeFile(join(home, "b.txt"), "hi");
    const handler = createBrowseHandler({ homeDir: home });

    const frame = (await handler(command({ payload: { path: "" } }))) as Record<string, unknown>;
    expect(frame).toMatchObject({ type: "rpc.result", commandId: "cmd-1", ok: true });
    const result = frame["result"] as {
      op: string;
      currentPath: string;
      entries: Array<{ name: string; isDir: boolean }>;
      truncated: boolean;
    };
    expect(result.op).toBe("fs.browse");
    expect(result.currentPath).toBe(home);
    expect(result.truncated).toBe(false);
    const names = result.entries.map((e) => e.name).sort();
    expect(names).toEqual(["a", "b.txt"]);
    expect(result.entries.find((e) => e.name === "a")?.isDir).toBe(true);
    expect(result.entries.find((e) => e.name === "b.txt")?.isDir).toBe(false);
  });

  test("defaults to homeDir when path is omitted", async () => {
    const home = await makeRoot();
    await mkdir(join(home, "proj"));
    const handler = createBrowseHandler({ homeDir: home });

    const frame = (await handler(command({ payload: {} }))) as Record<string, unknown>;
    expect(frame.ok).toBe(true);
    const result = frame["result"] as { currentPath: string; entries: Array<{ name: string }> };
    expect(result.currentPath).toBe(home);
    expect(result.entries.some((e) => e.name === "proj")).toBe(true);
  });

  test("expands leading tilde to homeDir", async () => {
    const home = await makeRoot();
    await mkdir(join(home, "proj"));
    const handler = createBrowseHandler({ homeDir: home });

    const frame = (await handler(command({ payload: { path: "~" } }))) as Record<string, unknown>;
    expect(frame.ok).toBe(true);
    const result = frame["result"] as { currentPath: string; entries: Array<{ name: string }> };
    expect(result.currentPath).toBe(home);
    expect(result.entries.some((e) => e.name === "proj")).toBe(true);
  });

  test("expands tilde-prefixed relative paths to homeDir", async () => {
    const home = await makeRoot();
    await mkdir(join(home, "proj"), { recursive: true });
    const handler = createBrowseHandler({ homeDir: home });

    const frame = (await handler(command({ payload: { path: "~/proj" } }))) as Record<
      string,
      unknown
    >;
    expect(frame.ok).toBe(true);
    const result = frame["result"] as { currentPath: string; entries: Array<{ name: string }> };
    expect(result.currentPath).toBe(join(home, "proj"));
  });

  test("browses an absolute path", async () => {
    const home = await makeRoot();
    const sub = join(home, "sub");
    await mkdir(sub);
    await writeFile(join(sub, "file.txt"), "hi");
    const handler = createBrowseHandler({ homeDir: home });

    const frame = (await handler(command({ payload: { path: sub } }))) as Record<string, unknown>;
    expect(frame.ok).toBe(true);
    const result = frame["result"] as { currentPath: string; entries: Array<{ name: string }> };
    expect(result.currentPath).toBe(sub);
    expect(result.entries.some((e) => e.name === "file.txt")).toBe(true);
  });

  test("detects git repos and claude project directories", async () => {
    const home = await makeRoot();
    const repo = join(home, "repo");
    const proj = join(home, "proj");
    await mkdir(repo);
    await mkdir(proj);
    await writeFile(join(repo, ".git"), "");
    await writeFile(join(proj, ".claude"), "");

    const handler = createBrowseHandler({ homeDir: home });
    const frame = (await handler(command({ payload: { path: "" } }))) as Record<string, unknown>;
    expect(frame.ok).toBe(true);
    const result = frame["result"] as {
      entries: Array<{ name: string; isGitRepo: boolean; hasClaudeProject: boolean }>;
    };
    const repoEntry = result.entries.find((e) => e.name === "repo");
    expect(repoEntry?.isGitRepo).toBe(true);
    expect(repoEntry?.hasClaudeProject).toBe(false);
    const projEntry = result.entries.find((e) => e.name === "proj");
    expect(projEntry?.isGitRepo).toBe(false);
    expect(projEntry?.hasClaudeProject).toBe(true);
  });

  test("provides home, root, and /mnt shortcuts when browsing home", async () => {
    const home = await makeRoot();
    const handler = createBrowseHandler({ homeDir: home });

    const frame = (await handler(command({ payload: { path: "~" } }))) as Record<string, unknown>;
    expect(frame.ok).toBe(true);
    const result = frame["result"] as { shortcuts: Array<{ label: string; path: string }> };
    expect(result.shortcuts).toContainEqual({ label: "~", path: home });
    expect(result.shortcuts).toContainEqual({ label: "/", path: "/" });
  });

  test("provides /mnt shortcut when /mnt exists", async () => {
    const home = await makeRoot();
    const handler = createBrowseHandler({ homeDir: home });

    const frame = (await handler(command({ payload: { path: "/" } }))) as Record<string, unknown>;
    expect(frame.ok).toBe(true);
    const result = frame["result"] as { shortcuts: Array<{ label: string; path: string }> };
    expect(result.shortcuts).toContainEqual({ label: "~", path: home });
    expect(result.shortcuts).toContainEqual({ label: "/", path: "/" });
    expect(result.shortcuts).toContainEqual({ label: "/mnt", path: "/mnt" });
  });

  test("sets parentPath to the parent directory when not at root", async () => {
    const home = await makeRoot();
    await mkdir(join(home, "child"));
    const handler = createBrowseHandler({ homeDir: home });

    const frame = (await handler(command({ payload: { path: "~/child" } }))) as Record<
      string,
      unknown
    >;
    expect(frame.ok).toBe(true);
    const result = frame["result"] as { currentPath: string; parentPath: string | null };
    expect(result.parentPath).toBe(home);
  });

  test("sets parentPath to null when browsing root", async () => {
    const home = await makeRoot();
    const handler = createBrowseHandler({ homeDir: home });

    const frame = (await handler(command({ payload: { path: "/" } }))) as Record<string, unknown>;
    expect(frame.ok).toBe(true);
    const result = frame["result"] as { parentPath: string | null };
    expect(result.parentPath).toBeNull();
  });

  test("filters hidden files unless showHidden is true", async () => {
    const home = await makeRoot();
    await writeFile(join(home, ".hidden"), "x");
    await writeFile(join(home, "visible.txt"), "hi");
    const handler = createBrowseHandler({ homeDir: home });

    const hiddenFrame = (await handler(
      command({ payload: { path: "", showHidden: false } }),
    )) as Record<string, unknown>;
    const hiddenResult = hiddenFrame["result"] as { entries: Array<{ name: string }> };
    expect(hiddenResult.entries.some((e) => e.name === ".hidden")).toBe(false);
    expect(hiddenResult.entries.some((e) => e.name === "visible.txt")).toBe(true);

    const shownFrame = (await handler(
      command({ payload: { path: "", showHidden: true } }),
    )) as Record<string, unknown>;
    const shownResult = shownFrame["result"] as { entries: Array<{ name: string }> };
    expect(shownResult.entries.some((e) => e.name === ".hidden")).toBe(true);
  });

  test("sorts directories first, then files, each alphabetically", async () => {
    const home = await makeRoot();
    await writeFile(join(home, "zfile.txt"), "hi");
    await writeFile(join(home, "afile.txt"), "hi");
    await mkdir(join(home, "bdir"));
    await mkdir(join(home, "adir"));
    const handler = createBrowseHandler({ homeDir: home });

    const frame = (await handler(command({ payload: { path: "" } }))) as Record<string, unknown>;
    expect(frame.ok).toBe(true);
    const result = frame["result"] as { entries: Array<{ name: string; isDir: boolean }> };
    // Directories first (alphabetical), then files (alphabetical).
    expect(result.entries).toEqual([
      expect.objectContaining({ name: "adir", isDir: true }),
      expect.objectContaining({ name: "bdir", isDir: true }),
      expect.objectContaining({ name: "afile.txt", isDir: false }),
      expect.objectContaining({ name: "zfile.txt", isDir: false }),
    ]);
  });

  test("truncates entries past MAX_BROWSE_ENTRIES", async () => {
    const home = await makeRoot();
    for (let i = 0; i < MAX_BROWSE_ENTRIES + 10; i++) {
      await mkdir(join(home, `d${String(i).padStart(4, "0")}`));
    }
    const handler = createBrowseHandler({ homeDir: home });

    const frame = (await handler(command({ payload: { path: "" } }))) as Record<string, unknown>;
    expect(frame.ok).toBe(true);
    const result = frame["result"] as { entries: unknown[]; truncated: boolean };
    expect(result.entries.length).toBe(MAX_BROWSE_ENTRIES);
    expect(result.truncated).toBe(true);
  });

  test("refuses a non-existent path as NOT_FOUND", async () => {
    const home = await makeRoot();
    const handler = createBrowseHandler({ homeDir: home });

    const frame = (await handler(command({ payload: { path: "~/does-not-exist" } }))) as Record<
      string,
      unknown
    >;
    expect(frame).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("refuses a path that is a file as NOT_A_DIRECTORY", async () => {
    const home = await makeRoot();
    await writeFile(join(home, "afile.txt"), "hi");
    const handler = createBrowseHandler({ homeDir: home });

    const frame = (await handler(command({ payload: { path: "~/afile.txt" } }))) as Record<
      string,
      unknown
    >;
    expect(frame).toMatchObject({ ok: false, error: { code: "NOT_A_DIRECTORY" } });
  });

  test("refuses an unreadable directory as PERMISSION_DENIED", async () => {
    const home = await makeRoot();
    const noRead = join(home, "noread");
    await mkdir(noRead, { mode: 0o000 });
    const handler = createBrowseHandler({ homeDir: home });

    // Skip on Windows — mode 0o000 doesn't block root there.
    if (process.platform === "win32") return;
    try {
      const frame = (await handler(command({ payload: { path: noRead } }))) as Record<
        string,
        unknown
      >;
      expect(frame).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    } finally {
      // Restore permissions so cleanup can proceed.
      await chmod(noRead, 0o755);
    }
  });

  test("refuses a non-object command with UNSUPPORTED_COMMAND", async () => {
    const home = await makeRoot();
    const handler = createBrowseHandler({ homeDir: home });

    const frame = (await handler(null)) as Record<string, unknown>;
    expect(frame).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_COMMAND" } });
  });

  test("refuses a non-browse kind with UNSUPPORTED_COMMAND", async () => {
    const home = await makeRoot();
    const handler = createBrowseHandler({ homeDir: home });

    const frame = (await handler(
      command({ kind: "workspace.inspect", payload: { op: "file.list" } }),
    )) as Record<string, unknown>;
    expect(frame).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_COMMAND" } });
  });

  test("refuses a malformed payload with UNSUPPORTED_COMMAND", async () => {
    const home = await makeRoot();
    const handler = createBrowseHandler({ homeDir: home });

    const frame = (await handler(command({ payload: { path: 123 } }))) as Record<string, unknown>;
    expect(frame).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_COMMAND" } });
  });

  test("echoes the commandId on every frame", async () => {
    const home = await makeRoot();
    const handler = createBrowseHandler({ homeDir: home });

    const frame = (await handler(command({ commandId: "my-id", payload: {} }))) as Record<
      string,
      unknown
    >;
    expect(frame["commandId"]).toBe("my-id");
    expect(frame["type"]).toBe("rpc.result");
  });

  test("falls back to process.env HOME when homeDir is not provided", async () => {
    const originalHome = process.env["HOME"];
    process.env["HOME"] = "/tmp";
    try {
      const handler = createBrowseHandler();
      const frame = (await handler(command({ payload: { path: "/" } }))) as Record<string, unknown>;
      expect(frame.ok).toBe(true);
      const result = frame["result"] as { shortcuts: Array<{ label: string; path: string }> };
      expect(result.shortcuts).toContainEqual({ label: "~", path: "/tmp" });
    } finally {
      process.env["HOME"] = originalHome;
    }
  });
});
