# Bounded Runner RPC + Read-Only Inspection (P3-A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the browser a bounded way to ask a runner a read-only question — directory listing, file content, git status, git diff, and redacted config diagnostics — over the existing authenticated runner socket.

**Architecture:** Inspections ride the existing durable outbox/inbox as commands, and the answer returns on one new frame, `rpc.result` (not an event — events are session-scoped and journaled; an inspection is neither). The runner answers inline, outside the attempt/lock machinery, resolving paths through its own registration. The server keeps an in-memory waiter registry, bounded at 10 s, and gates the whole surface on a minimal `inspect` capability the hello declares.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, Vue 3 + Tailwind, Vue Router. Tests via `bun test`. NO new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-26-p3a-bounded-runner-rpc-design.md` (16 rulings; the plan argues from it — read both).

## Global Constraints

- TypeScript: caret ranges only; `bun.lock` is truth; no version pinning.
- Backend comments and all test names in English. UI copy in Vietnamese with English domain nouns (runner, workspace, journal, run, file, diff).
- Tailwind utilities only in `apps/web` views; NEVER edit generated shadcn files (`apps/web/src/components/ui/**`, `apps/web/src/lib/utils.ts`, `apps/web/src/styles/index.css`, `components.json`).
- Security (§19.4, §15.2, verbatim): never log credentials or command payloads; `Cache-Control: no-store` on identity-bearing responses; Origin allowlist before side effects; prompts/source/transcripts are sensitive; **git only via argv arrays with an explicit cwd — no shell, no interpolation**; never `git reset`/`clean`/`stash`/`checkout -f`.
- Protocol version stays `1`; every new frame field is additive (§17.4).
- TDD: RED (verify the failure) → GREEN, per task. Commit per task.
- Gates at the end: `bun test`, `bun run typecheck`, `bunx biome check .`, `bun run test:integration`, `cd apps/web && bun run build`.
- Known gap: `.vue` SFCs are not typechecked here (TypeScript 7; `vue-tsc` uninstallable). Compensating control is `bun run build` plus a live pass — so keep every piece of panel *logic* in `.ts` modules under `apps/web/src/features/**` where `bun test` reaches it.

## Review Focus

The five input classes most likely to bite a user, each pinned to the task that owns the code:

1. **A path that escapes the workspace** (`..`, absolute, or a symlink out) — must be refused, never read. *(Task 3.)*
2. **A credential file** (`.env`, `id_rsa*`, `.credentials.json`, `*.pem`) — appears in a listing so the operator knows it is there, but its content is refused. *(Task 3 and Task 5.)*
3. **A huge or binary file** — bounded and flagged (`truncated`/`binary`), never returned as if it were the whole file. *(Tasks 1, 5, 11.)*
4. **A runner that is offline or lacks the capability** — answered `503` promptly, never a hung request. *(Tasks 7, 8, 9.)*
5. **A result that never arrives** (runner dies mid-request) — the HTTP request is bounded and no waiter or outbox row accumulates. *(Tasks 7, 9.)*

---

### Task 1: Protocol — inspect types, bounds and parsers

**Files:**
- Create: `packages/protocol/src/inspection.ts`
- Create: `packages/protocol/src/inspection.test.ts`
- Modify: `packages/protocol/src/index.ts` (re-export from `./inspection.ts`, matching the existing `export { ... } from "./reconcile.ts"` block style)

**Interfaces:**
- Produces (consumed by Tasks 2, 3, 5, 6, 7, 8, 9, 11):
  - `export const INSPECT_CAPABILITY = "inspect" as const`
  - `export const MAX_LISTING_ENTRIES = 2000`, `MAX_FILE_BYTES = 1024 * 1024`, `MAX_DIFF_BYTES = 256 * 1024`, `BINARY_SNIFF_BYTES = 8000`, `MAX_CHANGE_ENTRIES = 2000`
  - `export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted" | "typechange"`
  - `export type WorkspaceInspectRequest = { op: "file.list" | "file.read" | "git.diff"; path: string } | { op: "git.changes" }`
  - `export type ConfigInspectRequest = { op: "diagnostics" }`
  - `export type InspectRequest = WorkspaceInspectRequest | ConfigInspectRequest`
  - `export type DiagnosticsReport = { protocolVersion: number; runtime: string; workspaceRoot: string; sources: Array<{ source: "user" | "project" | "local"; path: string; exists: boolean; readable: boolean }>; gitAvailable: boolean; providerAuth: "configured" | "missing" | "unknown"; warnings: string[] }`
  - `export type FileListResult = { op: "file.list"; path: string; entries: Array<{ name: string; kind: "file" | "directory" | "other"; size: number }>; truncated: boolean }`
  - `export type FileReadResult = { op: "file.read"; path: string; content: string | null; binary: boolean; truncated: boolean; hash: string; size: number }`
  - `export type GitChangesResult = { op: "git.changes"; entries: Array<{ path: string; status: ChangeStatus; origPath?: string }>; truncated: boolean }`
  - `export type GitDiffResult = { op: "git.diff"; path: string; diff: string; truncated: boolean }`
  - `export type DiagnosticsResult = { op: "diagnostics"; report: DiagnosticsReport }`
  - `export type InspectResult = FileListResult | FileReadResult | GitChangesResult | GitDiffResult | DiagnosticsResult`
  - `export type RpcResultFrame = { type: "rpc.result"; commandId: string; ok: boolean; result?: InspectResult; error?: { code: string; message: string } }`
  - `export function parseInspectRequest(kind: string, payload: unknown): InspectRequest | undefined`
  - `export function parseRpcResultFrame(value: unknown): RpcResultFrame | undefined`

- [ ] **Step 1: Write the failing tests**

In `packages/protocol/src/inspection.test.ts`. Follow the existing parser-test idiom in `packages/protocol/src/reconcile.test.ts` (a `describe` per function, `expect(...).toBeUndefined()` for refusals).

```ts
describe("parseInspectRequest", () => {
  test("accepts file.list and file.read with a relative path", () => {
    expect(parseInspectRequest("workspace.inspect", { op: "file.list", path: "src" }))
      .toEqual({ op: "file.list", path: "src" });
    expect(parseInspectRequest("workspace.inspect", { op: "file.read", path: "a.ts" }))
      .toEqual({ op: "file.read", path: "a.ts" });
  });

  test("treats an empty path as the workspace root for file.list", () => {
    expect(parseInspectRequest("workspace.inspect", { op: "file.list", path: "" }))
      .toEqual({ op: "file.list", path: "" });
  });

  test("accepts git.changes with no path", () => {
    expect(parseInspectRequest("workspace.inspect", { op: "git.changes" }))
      .toEqual({ op: "git.changes" });
  });

  test("rejects an op the kind does not own", () => {
    expect(parseInspectRequest("workspace.inspect", { op: "diagnostics" })).toBeUndefined();
    expect(parseInspectRequest("config.inspect", { op: "file.read", path: "a" })).toBeUndefined();
  });

  test("accepts diagnostics only under config.inspect", () => {
    expect(parseInspectRequest("config.inspect", { op: "diagnostics" }))
      .toEqual({ op: "diagnostics" });
  });

  test("rejects a non-string path and a non-object payload", () => {
    expect(parseInspectRequest("workspace.inspect", { op: "file.read", path: 1 })).toBeUndefined();
    expect(parseInspectRequest("workspace.inspect", null)).toBeUndefined();
    expect(parseInspectRequest("workspace.inspect", "file.read")).toBeUndefined();
  });

  test("rejects an unknown kind", () => {
    expect(parseInspectRequest("workspace.file.write", { op: "file.read", path: "a" }))
      .toBeUndefined();
  });
});

describe("parseRpcResultFrame", () => {
  test("accepts a well-formed ok frame and an error frame", () => {
    const ok = { type: "rpc.result", commandId: "c1", ok: true,
      result: { op: "git.changes", entries: [], truncated: false } };
    expect(parseRpcResultFrame(ok)).toEqual(ok);

    const bad = { type: "rpc.result", commandId: "c1", ok: false,
      error: { code: "PATH_OUTSIDE_WORKSPACE", message: "refused" } };
    expect(parseRpcResultFrame(bad)).toEqual(bad);
  });

  test("rejects a wrong type, an empty commandId, and an ok frame with no result", () => {
    expect(parseRpcResultFrame({ type: "other", commandId: "c1", ok: true })).toBeUndefined();
    expect(parseRpcResultFrame({ type: "rpc.result", commandId: "", ok: true, result: { op: "git.changes", entries: [], truncated: false } })).toBeUndefined();
    expect(parseRpcResultFrame({ type: "rpc.result", commandId: "c1", ok: true })).toBeUndefined();
  });

  test("rejects an error frame with no error object", () => {
    expect(parseRpcResultFrame({ type: "rpc.result", commandId: "c1", ok: false })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/protocol/src/inspection.test.ts`
Expected: FAIL — `Cannot find module "./inspection.ts"`.

- [ ] **Step 3: Implement `packages/protocol/src/inspection.ts`**

Header comment must state the ruling it implements, in the house style (a paragraph, not a line): the frame is not an event because events are session-scoped and journaled (§12.1, §12.2) and an inspection has no run; the parsers are the untrusted boundary (§9.1's pattern).

`parseInspectRequest(kind, payload)`: return `undefined` for a non-object payload; switch on `kind`; within each kind switch on `op`; copy `path` only when `typeof === "string"`. `git.changes` takes no `path`. Nothing else is validated here — path safety is the runner's (Task 3), deliberately: a parser refusing `..` would be a second, weaker copy of the rule that matters.

`parseRpcResultFrame(value)`: require `type === "rpc.result"`, a non-empty string `commandId`, a boolean `ok`; when `ok` require a `result` object with a string `op`; when not `ok` require an `error` object with string `code` and `message`. Return a rebuilt object with only the known keys (never spread the raw input onto the wire — the existing parsers all rebuild).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/protocol/src/inspection.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Verify the export surface**

Run: `bun run typecheck`
Expected: exit 0. (Also confirms the `index.ts` re-export compiles.)

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/inspection.ts packages/protocol/src/inspection.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): add the bounded RPC result frame and inspect parsers"
```

---

### Task 2: Protocol — the hello declares an inspect capability

**Files:**
- Modify: `packages/protocol/src/handshake.ts`
- Modify: `packages/protocol/src/handshake.test.ts`
- Modify: `packages/protocol/src/index.ts` (`RunnerHello` gains `capabilities?: string[]`)

**Interfaces:**
- Consumes: `INSPECT_CAPABILITY` (Task 1).
- Produces (consumed by Tasks 8, 9):
  - `NegotiateResult`'s ok branch gains `capabilities: string[]`.
  - `export function parseCapabilities(value: unknown): string[] | undefined` (absent → `[]`; malformed → `undefined`).
  - `RunnerHello.capabilities?: string[]`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/protocol/src/handshake.test.ts`, matching its existing table style:

```ts
test("an absent capabilities field negotiates as an empty list", () => {
  const result = negotiateHello(hello({ /* no capabilities */ }), POLICY);
  expect(result).toMatchObject({ ok: true, capabilities: [] });
});

test("a runner declaring capabilities has them returned", () => {
  const result = negotiateHello(hello({ capabilities: ["inspect"] }), POLICY);
  expect(result).toMatchObject({ ok: true, capabilities: ["inspect"] });
});

test("capabilities that are not an array of non-empty strings are malformed", () => {
  for (const bad of ["inspect", [1], [""], {}]) {
    expect(negotiateHello(hello({ capabilities: bad }), POLICY)).toMatchObject({
      ok: false, reason: "malformed",
    });
  }
});

test("capabilities is not a forbidden field", () => {
  expect(Object.keys(hello({ capabilities: ["inspect"] }))).toContain("capabilities");
});
```

(`hello()` and `POLICY` are the existing helpers in that file; reuse them.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/protocol/src/handshake.test.ts`
Expected: FAIL — `capabilities` not returned / not parsed.

- [ ] **Step 3: Implement**

Add `parseCapabilities` beside `parseDeclaredWorkspaces`'s import; absent → `[]`; present but not an array of non-empty strings → `undefined` (the caller fails the hello). In `negotiateHello`, after the workspaces check, call it and `return fail("malformed", "capabilities must be an array of strings")` on `undefined`. Add `capabilities` to the ok branch's return. Do NOT add it to `FORBIDDEN_FIELDS`.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/protocol/src/handshake.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/handshake.ts packages/protocol/src/handshake.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): negotiate a runner's inspect capability in the hello"
```

---

### Task 3: Runner — workspace path safety

**Files:**
- Create: `apps/runner/src/inspection/paths.ts`
- Create: `apps/runner/src/inspection/paths.test.ts`

**Interfaces:**
- Produces (consumed by Task 5):
  - `export type PathRefusal = "PATH_OUTSIDE_WORKSPACE" | "FILE_NOT_FOUND" | "CREDENTIAL_FILE_REFUSED"`
  - `export type ResolvedPath = { ok: true; absolutePath: string } | { ok: false; code: PathRefusal }`
  - `export function isRefusedCredentialBasename(name: string): boolean`
  - `export async function resolveInsideWorkspace(root: string, relative: string, deps?: { realpath?: (p: string) => Promise<string | null>; stat?: (p: string) => Promise<{ isFile(): boolean; isDirectory(): boolean } | null> }): Promise<ResolvedPath>`

- [ ] **Step 1: Write the failing tests**

`paths.test.ts` uses a temp directory (`Bun.file`/`node:fs/promises`) and, where a symlink is needed, `symlink` from `node:fs/promises`. Each test creates its own temp root and removes it in `afterEach`.

```ts
test("resolves a plain relative path inside the root", async () => {
  // root/a.txt exists
  expect(await resolveInsideWorkspace(root, "a.txt")).toEqual({ ok: true, absolutePath: join(root, "a.txt") });
  expect(await resolveInsideWorkspace(root, "")).toEqual({ ok: true, absolutePath: root });
});

test("refuses a parent traversal", async () => {
  expect(await resolveInsideWorkspace(root, "../outside.txt"))
    .toEqual({ ok: false, code: "PATH_OUTSIDE_WORKSPACE" });
  expect(await resolveInsideWorkspace(root, "a/../../outside.txt"))
    .toEqual({ ok: false, code: "PATH_OUTSIDE_WORKSPACE" });
});

test("refuses an absolute path", async () => {
  expect(await resolveInsideWorkspace(root, "/etc/passwd"))
    .toEqual({ ok: false, code: "PATH_OUTSIDE_WORKSPACE" });
});

test("refuses a symlink that points outside the root", async () => {
  // root/escape -> /tmp/<other>
  expect(await resolveInsideWorkspace(root, "escape/secret.txt"))
    .toEqual({ ok: false, code: "PATH_OUTSIDE_WORKSPACE" });
});

test("allows a symlink that stays inside the root", async () => {
  // root/inside -> root/a.txt
  expect((await resolveInsideWorkspace(root, "inside")).ok).toBe(true);
});

test("refuses a credential basename", async () => {
  for (const name of [".env", ".env.local", "id_rsa", "id_ed25519.pub", ".credentials.json", "server.pem", "tls.key", ".netrc"]) {
    expect(await resolveInsideWorkspace(root, name)).toEqual({ ok: false, code: "CREDENTIAL_FILE_REFUSED" });
  }
});

test("does not mistake a benign name for a credential", async () => {
  for (const name of ["environment.ts", "keyboard.md", "pem.ts", "env.example.txt"]) {
    expect(isRefusedCredentialBasename(name)).toBe(false);
  }
});

test("reports a missing path as FILE_NOT_FOUND", async () => {
  expect(await resolveInsideWorkspace(root, "nope.txt")).toEqual({ ok: false, code: "FILE_NOT_FOUND" });
});
```

Also pin the ordering that matters: a `..` path to a credential name is refused as traversal, not as a credential (assert `PATH_OUTSIDE_WORKSPACE` for `../id_rsa`).

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/runner/src/inspection/paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Order, exactly as the design's Ruling 7 fixes it: (1) reject absolute and any `..` segment; (2) `resolve(root, relative)` then `realpath`, require the realpath to be inside `realpath(root)` (compare with a trailing separator so `/root2` is not read as inside `/root`); (3) credential basename check on the final segment; (4) `stat`, and a null stat is `FILE_NOT_FOUND`. The `deps` seam exists so the tests can pin each refusal without a filesystem for the pure cases; production calls the real `realpath`/`stat`.

The doc comment states the TOCTOU limit the design states: this is not a defence against a symlink swapped between the check and the open, and why that is acceptable under §2.1's trust model.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/runner/src/inspection/paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/inspection/paths.ts apps/runner/src/inspection/paths.test.ts
git commit -m "feat(runner): contain inspection paths and refuse credential files"
```

---

### Task 4: Runner — git status parser

**Files:**
- Create: `apps/runner/src/git/status.ts`
- Create: `apps/runner/src/git/status.test.ts`

**Interfaces:**
- Consumes: `MAX_CHANGE_ENTRIES`, `ChangeStatus` (Task 1).
- Produces (consumed by Task 5):
  - `export function parsePorcelainStatus(stdout: string, limit?: number): { entries: Array<{ path: string; status: ChangeStatus; origPath?: string }>; truncated: boolean }`

- [ ] **Step 1: Write the failing tests**

Feed literal `git status --porcelain=v1 -z` output (fields separated by NUL, `origPath` follows the new path for renames/copies):

```ts
test("parses modified, added, deleted and untracked entries", () => {
  const out = " M src/a.ts\0A  src/b.ts\0 D src/c.ts\0?? src/d.ts\0";
  expect(parsePorcelainStatus(out).entries).toEqual([
    { path: "src/a.ts", status: "modified" },
    { path: "src/b.ts", status: "added" },
    { path: "src/c.ts", status: "deleted" },
    { path: "src/d.ts", status: "untracked" },
  ]);
});

test("parses a rename with its original path", () => {
  const out = "R  new.ts\0old.ts\0";
  expect(parsePorcelainStatus(out).entries).toEqual([
    { path: "new.ts", status: "renamed", origPath: "old.ts" },
  ]);
});

test("parses a conflicted entry", () => {
  expect(parsePorcelainStatus("UU conflicted.ts\0").entries)
    .toEqual([{ path: "conflicted.ts", status: "conflicted" }]);
});

test("truncates past the limit", () => {
  const out = Array.from({ length: 5 }, (_, i) => ` M f${i}.ts\0`).join("");
  expect(parsePorcelainStatus(out, 2)).toEqual({
    entries: [{ path: "f0.ts", status: "modified" }, { path: "f1.ts", status: "modified" }],
    truncated: true,
  });
});

test("tolerates empty output and a trailing separator", () => {
  expect(parsePorcelainStatus("")).toEqual({ entries: [], truncated: false });
  expect(parsePorcelainStatus(" M a.ts\0").entries.length).toBe(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/runner/src/git/status.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Split on `"\0"`, drop the trailing empty field, take the first two characters as the XY code, map: `??` → untracked, `UU`/`AA`/`DD` (or any code containing `U`) → conflicted, else the first non-space of XY: `M`→modified, `A`→added, `D`→deleted, `R`→renamed, `C`→copied, `T`→typechange. For `R`/`C`, consume the following NUL field as `origPath`. Cap at `limit ?? MAX_CHANGE_ENTRIES` and set `truncated`.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/runner/src/git/status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/git/status.ts apps/runner/src/git/status.test.ts
git commit -m "feat(runner): parse git porcelain status into typed change entries"
```

---

### Task 5: Runner — the inspection handler

**Files:**
- Create: `apps/runner/src/inspection/handler.ts`
- Create: `apps/runner/src/inspection/handler.test.ts`

**Interfaces:**
- Consumes: `parseInspectRequest`, `RpcResultFrame`, the bounds constants (Task 1); `resolveInsideWorkspace` (Task 3); `parsePorcelainStatus` (Task 4); `GitSpawn` from `apps/runner/src/git/spawn.ts`.
- Produces (consumed by Task 6):
  - `export type InspectHandlerOptions = { workspacePathFor: (workspaceId: string) => string | undefined; spawn?: GitSpawn; now?: () => number; homeDir?: string; env?: Record<string, string | undefined> }`
  - `export function createInspectHandler(options: InspectHandlerOptions): (command: unknown) => Promise<RpcResultFrame>`

- [ ] **Step 1: Write the failing tests**

Script `spawn` with a fake `GitSpawn` (the M4 idiom in `apps/runner/src/git/*.test.ts`). Point `workspacePathFor` at a temp root.

```ts
test("answers file.list with typed entries", async () => {
  const frame = await handler(command({ kind: "workspace.inspect", payload: { op: "file.list", path: "" } }));
  expect(frame).toMatchObject({ ok: true, result: { op: "file.list", path: "", truncated: false } });
  expect(frame.result.entries.map((e) => e.name).sort()).toEqual(["a.txt", "sub"]);
  expect(frame.result.entries.find((e) => e.name === "sub")!.kind).toBe("directory");
});

test("answers file.read with content, hash and size", async () => {
  const frame = await handler(command({ kind: "workspace.inspect", payload: { op: "file.read", path: "a.txt" } }));
  expect(frame.result).toMatchObject({ op: "file.read", content: "hello\n", binary: false, truncated: false, size: 6 });
  expect(frame.result.hash).toMatch(/^[0-9a-f]{64}$/);
});

test("refuses a path outside the workspace with a code", async () => {
  const frame = await handler(command({ kind: "workspace.inspect", payload: { op: "file.read", path: "../x" } }));
  expect(frame).toMatchObject({ ok: false, error: { code: "PATH_OUTSIDE_WORKSPACE" } });
});

test("refuses a credential file's content", async () => {
  const frame = await handler(command({ kind: "workspace.inspect", payload: { op: "file.read", path: ".env" } }));
  expect(frame).toMatchObject({ ok: false, error: { code: "CREDENTIAL_FILE_REFUSED" } });
});

test("still lists a credential file by name", async () => {
  const frame = await handler(command({ kind: "workspace.inspect", payload: { op: "file.list", path: "" } }));
  expect(frame.result.entries.some((e) => e.name === ".env")).toBe(true);
});

test("flags a binary file and returns null content", async () => {
  // a file whose first bytes contain a NUL
  const frame = await handler(command({ kind: "workspace.inspect", payload: { op: "file.read", path: "bin.dat" } }));
  expect(frame.result).toMatchObject({ op: "file.read", binary: true, content: null });
});

test("truncates a file larger than the byte bound", async () => {
  // a file just over MAX_FILE_BYTES of 'a'
  const frame = await handler(command({ kind: "workspace.inspect", payload: { op: "file.read", path: "big.txt" } }));
  expect(frame.result.truncated).toBe(true);
  expect(Buffer.byteLength(frame.result.content, "utf8")).toBe(MAX_FILE_BYTES);
});

test("answers git.changes via the spawner in the workspace cwd", async () => {
  const spawn = scripted([{ exitCode: 0, stdout: " M a.ts\0" }]);
  const frame = await handlerWith(spawn, { kind: "workspace.inspect", payload: { op: "git.changes" } });
  expect(frame.result).toMatchObject({ op: "git.changes", truncated: false });
  expect(spawn.calls[0]).toEqual([["git", "status", "--porcelain=v1", "-z"], root]);
});

test("answers git.diff bounded to the diff byte cap", async () => {
  const spawn = scripted([{ exitCode: 0, stdout: "x".repeat(MAX_DIFF_BYTES + 100) }]);
  const frame = await handlerWith(spawn, { kind: "workspace.inspect", payload: { op: "git.diff", path: "a.ts" } });
  expect(frame.result.truncated).toBe(true);
  expect(spawn.calls[0][0]).toEqual(["git", "diff", "--", "a.ts"]);
});

test("answers diagnostics without reading any config content", async () => {
  const frame = await handler(command({ kind: "config.inspect", payload: { op: "diagnostics" } }));
  expect(frame.result).toMatchObject({ op: "diagnostics" });
  expect(frame.result.report.workspaceRoot).toBe(root);
  expect(frame.result.report.sources.map((s) => s.source)).toEqual(["user", "project", "local"]);
});

test("refuses an unknown workspace", async () => {
  const frame = await handler(command({ kind: "workspace.inspect", workspaceId: "nope", payload: { op: "git.changes" } }));
  expect(frame).toMatchObject({ ok: false, error: { code: "WORKSPACE_NOT_FOUND" } });
});

test("refuses a malformed payload", async () => {
  const frame = await handler(command({ kind: "workspace.inspect", payload: { op: "nope" } }));
  expect(frame).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_COMMAND" } });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/runner/src/inspection/handler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`createInspectHandler` returns an async function taking the raw command. It reads `kind`, `workspaceId`, `commandId`, `payload`. Resolve the workspace through `workspacePathFor`; `undefined` → `WORKSPACE_NOT_FOUND`. Parse via `parseInspectRequest(kind, payload)`; `undefined` → `UNSUPPORTED_COMMAND`. Dispatch on `op`:

- `file.list`: read the directory (one level), map to `{ name, kind, size }`, sort by name, cap at `MAX_LISTING_ENTRIES`.
- `file.read`: `resolveInsideWorkspace`; read the bytes; binary sniff on the first `BINARY_SNIFF_BYTES` (NUL byte); else decode UTF-8, truncating to `MAX_FILE_BYTES` bytes reproducibly and hashing the returned bytes with SHA-256.
- `git.changes`: `git status --porcelain=v1 -z` in the workspace cwd, `parsePorcelainStatus`.
- `git.diff`: `git diff -- <path>` (argv array, path as one element — §15.2), truncate the text to `MAX_DIFF_BYTES`.
- `diagnostics`: build `DiagnosticsReport` — `runtime` from `process.versions.bun` (no paths), `workspaceRoot` = the resolved root, `sources` = the three §7.2 locations with `exists`/`readable` only, `gitAvailable` from a `git --version` spawn, `providerAuth` a presence check (env key set, or the credentials file exists — never its content), `warnings` empty in P3-A.

Every failure returns `{ ok: false, error: { code, message } }` with a redacted message (`redactErrorText`), never a raw stack. The doc comment states why no lock is taken (Ruling 6) and why the report is built by construction so it cannot carry a secret (Ruling 9).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/runner/src/inspection/handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/inspection/handler.ts apps/runner/src/inspection/handler.test.ts
git commit -m "feat(runner): answer read-only inspections without taking the workspace lock"
```

---

### Task 6: Runner — explicit command-kind switch and the widened handler return

**Files:**
- Modify: `apps/runner/src/execution/run-controller.ts`
- Modify: `apps/runner/src/execution/run-controller.test.ts`
- Modify: `apps/runner/src/connection/reconnect-loop.ts`
- Modify: `apps/runner/src/connection/reconnect-loop.test.ts`
- Modify: `apps/runner/src/daemon.ts`
- Modify: `apps/runner/src/daemon.test.ts`

**Interfaces:**
- Consumes: `createInspectHandler`, `RpcResultFrame` (Tasks 1, 5).
- Produces:
  - `export type CommandOutcome = { receipt: CommandReceipt; results?: RpcResultFrame[] }` (in `reconnect-loop.ts`)
  - `export type CommandHandler = (command: unknown) => Promise<CommandOutcome>` (replaces the receipt-only type)
  - `RunController.handle(command): Promise<CommandReceipt>` — unchanged signature, but now refuses unrecognised kinds.
  - `DaemonOptions.inspect?` — absent builds the real handler from `workspacePathFor` (so tests can inject a fake).

- [ ] **Step 1: Write the failing tests**

Three focused RED tests, one per layer:

`run-controller.test.ts` — the defect Ruling 5 fixes:

```ts
test("refuses a command kind it does not implement instead of starting a run", async () => {
  const receipt = await controller.handle({
    protocolVersion: 1, commandId: "c1", runnerId: "r1", kind: "workspace.inspect",
    issuedAt: new Date().toISOString(), workspaceId: "default", payload: { op: "git.changes" },
  });
  expect(receipt).toMatchObject({ accepted: false, reason: "unsupported_command" });
  // And nothing was begun:
  expect(db.query("SELECT COUNT(*) AS n FROM local_attempts").get()).toEqual({ n: 0 });
});
```

`reconnect-loop.test.ts` — ordering and the second frame:

```ts
test("sends the handler's result frames after the receipt", async () => {
  // handler returns { receipt, results: [rpcResult] }
  // assert the socket saw command.receipt first, then rpc.result
});

test("sends no receipt when the handler returns only results", async () => {
  // handler returns { receipt: undefined? } — see Step 3: an inspect outcome carries
  // an explicit `receipt: null`; assert exactly one frame, the rpc.result
});
```

`daemon.test.ts` — the composition:

```ts
test("routes an inspect command to the inspect handler, not the run controller", async () => {
  // inject fake `inspect`; send a workspace.inspect command through the loop;
  // assert the fake was called and `runs.handle` was not
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/runner/src/execution/run-controller.test.ts apps/runner/src/connection/reconnect-loop.test.ts apps/runner/src/daemon.test.ts`
Expected: FAIL — the run controller begins an attempt for `workspace.inspect`; the loop sends only a receipt.

- [ ] **Step 3: Implement**

`reconnect-loop.ts`: define
```ts
export type CommandOutcome = { receipt: CommandReceipt | null; results?: RpcResultFrame[] };
```
Change `CommandHandler` to `(command: unknown) => Promise<CommandOutcome>`. In `#handleCommand`, after awaiting, send `outcome.receipt` when it is not `null`, then `outcome.results` in order. Update the existing error path to produce `{ receipt: { ...refused } }`. The doc comment states Ruling 14's ordering rule and why the seam widened rather than a callback being threaded.

`run-controller.ts`: `handle`'s existing early branches (`run.cancel`, `approval.respond`) stay; the fall-through that assumed "everything else is a start" becomes an explicit check — only `kind === "run.start"` proceeds to the attempt/workspace block, and anything else returns `{ ...receipt(parsed, false), reason: "unsupported_command" }` **before** `beginAttempt`. Keep the existing `unknown_workspace` ordering for `run.start`.

`daemon.ts`: add `inspect?: (command: unknown) => Promise<RpcResultFrame>` to `DaemonOptions`; default it to `createInspectHandler({ workspacePathFor: options.workspacePathFor ?? (() => undefined) })` — reusing the daemon's already-resolved `workspacePathFor` (line 191), not re-deriving from `defaultWorkspaceResolver`, so the env→path wiring stays in `main.ts` as its single source of truth. Change `onCommand` to a pre-switch: `kind` of `workspace.inspect`/`config.inspect` → `{ receipt: null, results: [await inspect(command)] }`; every other kind → `{ receipt: await runs.handle(command) }`. The pre-switch reads `kind` defensively (a non-object command falls through to `runs.handle`, which already refuses malformed).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/runner/src/execution/run-controller.test.ts apps/runner/src/connection/reconnect-loop.test.ts apps/runner/src/daemon.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole runner suite (the return-type change is wide)**

Run: `bun test apps/runner`
Expected: PASS — no other test relied on the old handler return shape (fix any that did; the shape change is deliberate).

- [ ] **Step 6: Commit**

```bash
git add apps/runner/src/execution/run-controller.ts apps/runner/src/execution/run-controller.test.ts apps/runner/src/connection/reconnect-loop.ts apps/runner/src/connection/reconnect-loop.test.ts apps/runner/src/daemon.ts apps/runner/src/daemon.test.ts
git commit -m "feat(runner): refuse unknown commands and carry rpc.result on the command outcome"
```

---

### Task 7: Server — the bounded pending-request registry

**Files:**
- Create: `apps/control-server/src/rpc/pending-requests.ts`
- Create: `apps/control-server/src/rpc/pending-requests.test.ts`

**Interfaces:**
- Consumes: `RpcResultFrame` (Task 1).
- Produces (consumed by Tasks 8, 9):
  - `export const RPC_WAIT_MS = 10_000`
  - `export class PendingRpcRequests`
    - `constructor(options?: { timeoutMs?: number; schedule?: (fn: () => void, ms: number) => unknown; unschedule?: (handle: unknown) => void })`
    - `register(commandId: string): Promise<RpcResultFrame>`
    - `settle(frame: RpcResultFrame): boolean` (false = no waiter; drops)
    - `reject(commandId: string, code: string): boolean`
    - `size(): number` (test observability)

- [ ] **Step 1: Write the failing tests**

Inject `schedule`/`unschedule` (the M5 pump seam idiom) so the clock is virtual:

```ts
test("resolves a registered request when its frame settles", async () => {
  const reg = new PendingRpcRequests();
  const p = reg.register("c1");
  expect(reg.settle({ type: "rpc.result", commandId: "c1", ok: true, result: { op: "git.changes", entries: [], truncated: false } })).toBe(true);
  expect((await p).ok).toBe(true);
});

test("drops a frame with no waiter", () => {
  const reg = new PendingRpcRequests();
  expect(reg.settle({ type: "rpc.result", commandId: "gone", ok: true, result: { op: "git.changes", entries: [], truncated: false } })).toBe(false);
});

test("rejects with RUNNER_UNAVAILABLE after the timeout and forgets the waiter", async () => {
  const clock = fakeClock();
  const reg = new PendingRpcRequests({ timeoutMs: 10_000, schedule: clock.schedule, unschedule: clock.unschedule });
  const p = reg.register("c1");
  clock.advance(10_000);
  await expect(p).rejects.toMatchObject({ code: "RUNNER_UNAVAILABLE" });
  expect(reg.size()).toBe(0);
});

test("a settle cancels the timeout and does not reject afterwards", async () => {
  const clock = fakeClock();
  const reg = new PendingRpcRequests({ schedule: clock.schedule, unschedule: clock.unschedule });
  const p = reg.register("c1");
  reg.settle({ type: "rpc.result", commandId: "c1", ok: true, result: { op: "git.changes", entries: [], truncated: false } });
  clock.advance(60_000);
  await expect(p).resolves.toMatchObject({ ok: true });
  expect(clock.cancelled.length).toBeGreaterThan(0);
});

test("reject settles the waiter with the given code", async () => {
  const reg = new PendingRpcRequests();
  const p = reg.register("c1");
  reg.reject("c1", "RUNNER_UNAVAILABLE");
  await expect(p).rejects.toMatchObject({ code: "RUNNER_UNAVAILABLE" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/control-server/src/rpc/pending-requests.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

A `Map<string, { resolve; reject; timer }>`. `register` creates the promise, arms the timeout, stores the entry, returns the promise. `settle` looks up, and on a hit unschedules and resolves (never rejects an already-settled entry — one `settle` per command id); on a miss returns `false`. `reject` behaves the same with a rejection carrying `{ code }`. `size()` returns the map length after cleanup. Doc comment states Ruling 3: in-memory because the waiter is an HTTP request whose life cannot outlive the process, and a result for an unknown id is dropped because that race is expected, not an error.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/control-server/src/rpc/pending-requests.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-server/src/rpc/pending-requests.ts apps/control-server/src/rpc/pending-requests.test.ts
git commit -m "feat(server): bound RPC waiters with an in-memory pending-request registry"
```

---

### Task 8: Server — the gateway accepts `rpc.result` and stores capabilities

**Files:**
- Modify: `apps/control-server/src/websocket/runner/runner-gateway.ts`
- Modify: `apps/control-server/src/websocket/runner/runner-gateway.test.ts`

**Interfaces:**
- Consumes: `parseRpcResultFrame`, `INSPECT_CAPABILITY` (Task 1); negotiate's `capabilities` (Task 2).
- Produces (consumed by Task 9):
  - `GatewayOptions.onRpcResult?: (runnerId: string, frame: RpcResultFrame) => void`
  - `RunnerGateway.capabilitiesOf(runnerId: string): readonly string[]` — the ready connection's declared capabilities, `[]` when nothing is live.

- [ ] **Step 1: Write the failing tests**

```ts
test("dispatches an rpc.result frame to onRpcResult", () => {
  // run hello+reconcile to ready, send { type: "rpc.result", commandId: "c1", ok: true, result: {...} }
  expect(received).toEqual([{ runnerId, frame: expect.objectContaining({ commandId: "c1" }) }]);
});

test("refuses a malformed rpc.result without closing the socket", () => {
  // send { type: "rpc.result", commandId: "" } and assert an error frame, socket still usable
});

test("exposes the capabilities the hello declared", () => {
  // hello with capabilities: ["inspect"]; expect capabilitiesOf(runnerId) to contain "inspect"
});

test("reports no capabilities for an offline runner", () => {
  expect(gateway.capabilitiesOf("nobody")).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/control-server/src/websocket/runner/runner-gateway.test.ts`
Expected: FAIL — `rpc.result` hits the `default` branch (`unknown_message`); `capabilitiesOf` does not exist.

- [ ] **Step 3: Implement**

Add `capabilities: string[]` to the `Connection` type, set from the negotiate result in `#handleHello` (a reconnect that re-declares replaces it). Add a `case "rpc.result"`: parse with `parseRpcResultFrame`; `undefined` → `#send(connection, { type: "error", reason: "malformed" })` and `{ ok: false, reason: "malformed" }` (do NOT close — a malformed frame from a live runner is a bug, not an attack, and the socket still carries events). A valid frame calls `#onRpcResult`, exactly as `#handleReceipt` calls `#onReceipt`. Add `capabilitiesOf(runnerId)`.

Note in the header comment: this is a fourth inbound frame beside `hello`/`reconcile`/`command.receipt`/`events`, and it is deliberately not an event (Ruling 1).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/control-server/src/websocket/runner/runner-gateway.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-server/src/websocket/runner/runner-gateway.ts apps/control-server/src/websocket/runner/runner-gateway.test.ts
git commit -m "feat(server): accept rpc.result and track declared capabilities"
```

---

### Task 9: Server — the inspect HTTP routes

**Files:**
- Create: `apps/control-server/src/routes/inspect-routes.ts`
- Create: `apps/control-server/src/routes/inspect-routes.test.ts`
- Modify: `apps/control-server/src/server.ts` (wire the five routes; construct the registry; connect `onRpcResult`)

**Interfaces:**
- Consumes: everything above; `PendingRpcRequests` (Task 7); `gateway.capabilitiesOf` (Task 8); `CommandOutbox.enqueue`/`markRejected`; `workspacesForOwner` (control-db).
- Produces (consumed by Task 11):
  - `export function parseCompositeId(id: string): { runnerId: string; workspaceId: string } | undefined`
  - `export async function handleInspect(request, options, allowedOrigins, browserGateway, runnerGateway, pending, dispatcher, compositeId, op): Promise<Response>`

- [ ] **Step 1: Write the failing tests**

Follow `runners-routes.test.ts`'s harness (real `createServer`, a fake runner link, seeded owner + runner + workspace). Cover each branch:

```ts
test("reads a file through the runner and returns its content", ...);       // 200, run the fake link's rpc.result
test("401 without a cookie, 403 from a foreign origin", ...);
test("404 for a workspace the owner does not own", ...);
test("400 for a malformed composite id", ...);                              // parseCompositeId unit-tested below
test("503 promptly when the runner is offline", ...);                       // answers without waiting the timeout
test("503 when the runner does not declare the inspect capability", ...);
test("503 RUNNER_UNAVAILABLE when the runner never answers", ...);          // virtual clock or a short timeout seam
test("a refused inspection returns its code and a no-store header", ...);   // PATH_OUTSIDE_WORKSPACE 400-class JSON
test("the outbox row is retired when the (timed-out) request gives up", ...); // assert no pending row remains

describe("parseCompositeId", () => {
  test("splits on the first slash", () => {
    expect(parseCompositeId("r-1/ws-1")).toEqual({ runnerId: "r-1", workspaceId: "ws-1" });
  });
  test("rejects a missing or empty half", () => {
    expect(parseCompositeId("r-1")).toBeUndefined();
    expect(parseCompositeId("/ws")).toBeUndefined();
    expect(parseCompositeId("r-1/")).toBeUndefined();
  });
  test("URL-decodes each half before splitting", () => {
    expect(parseCompositeId(encodeURIComponent("r 1") + "/" + encodeURIComponent("ws/2")))
      .toEqual({ runnerId: "r 1", workspaceId: "ws/2" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/control-server/src/routes/inspect-routes.test.ts`
Expected: FAIL — module not found; routes 404.

- [ ] **Step 3: Implement**

`parseCompositeId`: `decodeURIComponent` the whole id, then split on the first `/`; both halves must be non-empty; a decode failure → `undefined`.

`handleInspect`, in this order: Origin allowlist (403) → cookie auth (401) → `parseCompositeId` (400) → find the workspace in `workspacesForOwner(db, userId)` (404 `WORKSPACE_NOT_FOUND`; the owner scoping is the access rule) → `runnerGateway.stateOf(runnerId) !== "ready"` → 503 `RUNNER_UNAVAILABLE` → `capabilitiesOf` lacks `inspect` → 503 `RUNNER_UNAVAILABLE` (same answer, no new browser branch) → `pending.register(commandId)` → `outbox.enqueue({ kind, workspaceId, payload, expiresAt: now + 15s })` → `dispatcher.drain(runnerId)` → await the waiter with the 10 s bound → on timeout `outbox.markRejected(commandId, "expired")` then 503 → on a `{ ok: false }` frame return the mapped status (`PATH_OUTSIDE_WORKSPACE`/`CREDENTIAL_FILE_REFUSED`/`FILE_NOT_FOUND` → 400/403/404, `WORKSPACE_NOT_FOUND` → 404, else 502) with the §17.3 JSON `ApiError` body → on `{ ok: true }` return the result JSON with `Cache-Control: no-store`.

`server.ts`: build `const pending = new PendingRpcRequests()` beside `browserGateway`; pass `onRpcResult: (_runnerId, frame) => { pending.settle(frame); }` to `RunnerGateway`; match the five paths with the existing regex idiom:
`/^\/api\/workspaces\/([^/]+)\/files$/` (GET), `.../file$` (GET), `.../changes$` (GET), `.../diff$` (GET), `.../config\/diagnostics$` (GET), passing the `op` and reading `path` from the query string.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/control-server/src/routes/inspect-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-server/src/routes/inspect-routes.ts apps/control-server/src/routes/inspect-routes.test.ts apps/control-server/src/server.ts
git commit -m "feat(server): expose bounded read-only inspection over HTTP"
```

---

### Task 10: Server — the session list carries the pin

**Files:**
- Modify: `packages/control-db/src/replay.ts`
- Modify: `packages/control-db/src/replay.test.ts`
- Modify: `apps/web/src/stores/sessions.ts` (`SessionSummary` gains the two nullable fields — type only, no behaviour)

**Interfaces:**
- Produces (consumed by Task 13):
  - `SessionSummary` gains `runnerId: string | null` and `workspaceId: string | null`.

- [ ] **Step 1: Write the failing tests**

```ts
test("answers a session's pin from the sessions table", () => {
  // insert a sessions row for a session that also has events
  const [summary] = listSessions(db, "owner-1");
  expect(summary).toMatchObject({ runnerId: "r-1", workspaceId: "ws-1" });
});

test("reports a null pin for a session with no pin row", () => {
  // a session that only has events (dispatch before the pin milestone)
  expect(summary).toMatchObject({ runnerId: null, workspaceId: null });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/control-db/src/replay.test.ts`
Expected: FAIL — the fields are absent.

- [ ] **Step 3: Implement**

Add `LEFT JOIN sessions s ON s.id = e.session_id` (and on the `active_runs` query) selecting `s.runner_id`, `s.workspace_id`; map `null` through as `null`. Do not change ordering or the existing fields.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/control-db/src/replay.test.ts && bun run typecheck`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/control-db/src/replay.ts packages/control-db/src/replay.test.ts apps/web/src/stores/sessions.ts
git commit -m "feat(control-db): answer each session's workspace pin in the session list"
```

---

### Task 11: Web — the inspect API service

**Files:**
- Create: `apps/web/src/services/inspect-api.ts`
- Create: `apps/web/src/services/inspect-api.test.ts`

**Interfaces:**
- Consumes: the result types (Task 1); the endpoints (Task 9).
- Produces (consumed by Task 13):
  - `export function compositeId(runnerId: string, workspaceId: string): string`
  - `export type InspectOutcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string }`
  - `export async function listFiles(id, path): Promise<InspectOutcome<FileListResult>>`
  - `export async function readFile(id, path): Promise<InspectOutcome<FileReadResult>>`
  - `export async function fetchChanges(id): Promise<InspectOutcome<GitChangesResult>>`
  - `export async function fetchDiff(id, path): Promise<InspectOutcome<GitDiffResult>>`
  - `export async function fetchDiagnostics(id): Promise<InspectOutcome<DiagnosticsResult>>`

- [ ] **Step 1: Write the failing tests**

Stub `globalThis.fetch` and restore it in `afterEach` (the repo rule: `bun test` is one process). Follow `runs-api.test.ts`'s idiom (status → outcome mapping lives in the service, never in a component).

```ts
test("maps a 200 into an ok outcome with the parsed result", ...);
test("maps a JSON ApiError body into its code and message", ...);
test("maps a non-JSON 5xx into a generic code, never a thrown parse", ...);
test("maps a network failure into code \"error\" without throwing", ...);
test("encodes the path query and the composite id", ...);   // assert the requested URL
test("compositeId joins with a slash and encodes each half", () => {
  expect(compositeId("r 1", "ws/2")).toBe("r%201/ws%2F2");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/web/src/services/inspect-api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Pure mapping, mirroring `runs-api.ts`: build the URL with `compositeId` and `encodeURIComponent(path)`; on a non-OK response try to read the §17.3 JSON `{ error: { code, message } }` and fall back to a generic code when the body is not JSON; never throw. `compositeId` encodes each half so a `workspaceId` containing `/` survives the round trip (the server decodes then splits — Task 9).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/web/src/services/inspect-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/inspect-api.ts apps/web/src/services/inspect-api.test.ts
git commit -m "feat(web): add the inspect API client"
```

---

### Task 12: Web — panel logic modules (breadcrumbs, diff lines, size)

**Files:**
- Create: `apps/web/src/features/inspect/breadcrumbs.ts`
- Create: `apps/web/src/features/inspect/breadcrumbs.test.ts`
- Create: `apps/web/src/features/inspect/diff-lines.ts`
- Create: `apps/web/src/features/inspect/diff-lines.test.ts`
- Create: `apps/web/src/features/inspect/change-label.ts`
- Create: `apps/web/src/features/inspect/change-label.test.ts`

**Interfaces:**
- Consumes: `ChangeStatus` (Task 1).
- Produces (consumed by Task 13):
  - `export type Crumb = { label: string; path: string }`
  - `export function breadcrumbs(path: string): Crumb[]` — `""` → `[]`; `"a/b/c"` → `[{label:"a",path:"a"},{label:"b",path:"a/b"},{label:"c",path:"a/b/c"}]`; a `path` is never trusted to start with `/`.
  - `export type DiffLine = { kind: "add" | "del" | "context" | "hunk" | "meta"; text: string }`
  - `export function classifyDiff(diff: string): DiffLine[]` — `+`→add (but `+++`→meta), `-`→del (but `---`→meta), `@@`→hunk, `diff --git`/`index `/`new file`/`deleted file` → meta, else context.
  - `export function changeLabel(status: ChangeStatus): string` — VN label with the English status noun (`"thêm"`, `"sửa"`, `"xoá"`, `"đổi tên"`, `"sao chép"`, `"chưa theo dõi"`, `"xung đột"`, `"đổi loại"`).
  - `export function formatSize(bytes: number): string` — `"512 B"`, `"1,5 KiB"` (VN decimal comma, matching the repo's token formatting).

- [ ] **Step 1: Write the failing tests**

One `describe` per module, table-driven where it fits. Pin the classification boundaries (`+++`/`---` are meta, not add/del) — that is the case a naive `startsWith("+")` gets wrong.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/web/src/features/inspect`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Pure functions, no Vue import, no DOM. Comments only where a rule is non-obvious (the `+++` boundary, the VN decimal comma).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/web/src/features/inspect`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/inspect
git commit -m "feat(web): add inspect panel logic helpers"
```

---

### Task 13: Web — the read-only panels on the session view

**Files:**
- Create: `apps/web/src/components/WorkspacePanel.vue` (the tab strip + Files/Changes/Diagnostics bodies)
- Modify: `apps/web/src/views/SessionView.vue` (mount the panel in the right column; read the pin from the sessions store)
- Modify: `apps/web/src/stores/sessions.ts` only if the summary type needs the fields threaded (Task 10 added them).

**Interfaces:**
- Consumes: `inspect-api` (Task 11), the feature modules (Task 12), `SessionSummary.runnerId/workspaceId` (Task 10).

- [ ] **Step 1: Implement the panel**

Tailwind utilities only. Behaviours, all render-only:

- No pin (`runnerId === null`) → the panel shows "Không rõ workspace của phiên này" and fetches nothing.
- A tab strip (Files / Changes / Diagnostics) driven by a local `ref`; the tab is local component state (§16.2).
- Files: breadcrumbs from `breadcrumbs(path)`; `listFiles` on tab open and on descent; each row is a button that descends into a directory or opens a file; a `<pre>` for content; banners for `binary` ("tệp nhị phân"), `truncated` ("đã cắt bớt"), and a `CREDENTIAL_FILE_REFUSED` code ("tệp thông tin đăng nhập — không hiển thị nội dung").
- Changes: `fetchChanges` list with `changeLabel`; clicking a row calls `fetchDiff` and renders `classifyDiff` output in a `<pre>` with per-line tinting from existing theme tokens (`text-destructive` for del; a muted/secondary for add — reuse what the journal already uses, do not introduce a new palette).
- Diagnostics: `fetchDiagnostics` as a labeled list; `providerAuth` shown as a word, never a value.
- Every failed call renders its `code`/`message` inline (VN copy, the English code in parens) — no toast spam for a panel read.

- [ ] **Step 2: Verify the app builds**

Run: `cd apps/web && bun run build`
Expected: exit 0. (This is the only check that reaches the SFC; it is the compensating control for the `.vue` typecheck gap.)

- [ ] **Step 3: Run the full gates**

Run: `bun test && bun run typecheck && bunx biome check .`
Expected: all green. Fix any biome formatting it reports (`bunx biome check --write <file>`).

- [ ] **Step 4: Live pass (manual, documented)**

Start the demo stack (control server + fake runner + vite; see the handoff's standing recipe), log in, open a session with a pin, and confirm: the Files tab lists and opens a file, a refused credential file shows the refusal, the Changes tab lists and shows a diff, Diagnostics renders. Record the result in the ledger. (The fake runner must be extended to answer `rpc.result` for this pass — a local `/tmp` file, never committed.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/WorkspacePanel.vue apps/web/src/views/SessionView.vue
git commit -m "feat(web): show a read-only workspace panel on the session view"
```

---

## Self-review notes

- **Spec coverage:** every ruling maps to a task — 1→T1, 2/14/16→T6+T7+T9, 3→T7+T9, 4/9/11→T5, 5→T6, 6→T5, 7→T3, 8→T1+T5, 10→T9, 12→T10+T12+T13, 13→T2+T8+T9, 15→T6. `git.changes` bound is T4/T8. No ruling is unimplemented.
- **Type consistency:** `RpcResultFrame`, `InspectResult`, `ChangeStatus`, `CommandOutcome`, `PendingRpcRequests`, `parseCompositeId`, `compositeId` are each defined once and reused by name.
- **Review Focus:** each of the five lines is pinned by a named test in T3, T3/T5, T1/T5/T11, T7/T8/T9, T7/T9.
- **Deliberate non-goal surfaced by the design:** writes/revert/snapshots (P3-B), profiles (P3-C), CodeMirror (P3-D) are not in this plan.
