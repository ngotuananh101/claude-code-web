# P3-B — Writes, Revert, and Run-Start Snapshots

Date: 2026-10-27
Status: draft for approval
Predecessor: P3-A bounded Runner RPC (read-only inspection), shipped on `main` at
`24c1d6d`.

## 1. Intent

P3-A made the workspace panel a reader. P3-B makes it an editor with an undo
that means something: save a file the operator changed, and restore the
workspace to the state it had **when the run started** — per file, or the whole
workspace at once.

The operator asked for both halves explicitly:

> "tôi muốn bao gồm cả. khi khôi phục thì về lúc bắt đầu chạy nhé"
> "Tôi muốn có revert cả workspace"

So the baseline is the *run-start snapshot*, not HEAD: uncommitted work that
existed before the run is part of the baseline and survives a revert (§15.5
"User pre-existing edits không bị xóa"), while anything created during the run
can be removed by an explicit, previewed workspace revert.

## 2. Goals

1. **Revision-checked save.** `PUT /api/workspaces/:id/file` writes through the
   runner only when the caller's `expectedHash` matches the bytes on disk;
   mismatch is `409 FILE_CONFLICT` and nothing is overwritten (§15.2).
2. **Run-start baseline.** Every run captures a file snapshot *after* the branch
   gate (`prepareWorkspace`) and *before* the SDK starts, so the baseline is the
   tree the agent first saw.
3. **Per-file revert.** Restore one path to its baseline content, or delete it
   when it did not exist at run start — conditioned on the current content hash
   the operator reviewed.
4. **Whole-workspace revert, two-phase.** A preview lists every restore, every
   deletion and every conflict with a digest; apply runs only when the world
   still matches that preview (`409 REVERT_STALE` otherwise).
5. **A panel that carries the controls honestly.** The Files tab becomes a text
   editor with Save; the Changes tab gains a "since run start" source with
   per-file revert and a workspace-revert flow behind an explicit confirmation.

## 3. Non-goals

- Commit, accept/reject, branch creation (§15.5 keeps commit a separate action;
  P3-C/P3-D territory).
- CodeMirror or a merge view — P3-B ships a plain `<textarea>`; P3-D replaces it.
- Creating new files, or deleting files, through Save. Save edits existing
  regular text files only; deletion happens only through revert, and only for
  paths the runner observed as created during the run.
- Binary editing. Binary files are snapshotted (so they can be restored), but
  the panel never edits them.
- Snapshot *diff rendering*. Status lists paths and hashes; unified diffs stay
  `git.diff` (HEAD baseline).
- History over old snapshots. Retention keeps the five most recent baselines
  per workspace; only the latest is surfaced.
- `Idempotency-Key` (§17.3). No mutation route in the repo implements it yet
  (runs, approvals included); adding it is a repo-wide slice of its own. P3-B's
  mutations are protected by the content hash token and by terminal outbox
  states, and a retried save/revert fails closed with `FILE_CONFLICT` rather
  than corrupting anything. Ledgered.

## 4. Anti-goals (would make P3-B a failure even if it works)

- `git reset --hard` or `git clean` anywhere (§15.5 forbids them as revert).
- Writing through a symlink, or outside the registered workspace root.
- Overwriting a file whose hash does not match what the operator saw.
- Bulk-deleting any path the runner cannot prove was created during the run —
  in particular never deleting credential files, symlinks, or directories.
- Sending file contents over the RPC for status/plan; the wire carries paths,
  hashes and sizes only.
- Auto-commit, auto-push or auto-deploy from Reviewed/Save/Revert (§15.5).

## 5. Constraints taken from ARCHITECTURE.md

- §15.2: "Save với expected content hash; conflict → HTTP 409/domain error,
  không overwrite." · "Atomic write phù hợp với permissions và loại file; không
  xuyên symlink bất ngờ." · "Relative paths, realpath/containment checks,
  symlink handling và TOCTOU mitigation." · "Chặn device/socket, path ngoài
  scope, file quá lớn hoặc binary không hỗ trợ."
- §15.4: baseline 2 is "Run-start snapshot → current: thay đổi trong khoảng run,
  có thể gồm external edits"; "File snapshots có size/retention limits, chứa dữ
  liệu nhạy cảm như source code."
- §15.5: "Không dùng `git reset --hard` / `git clean` làm nút revert mặc định."
  · "Revert chỉ khi baseline và current revision khớp; external change thì review
  conflict." · "User pre-existing edits không bị xóa." · "Commit là action độc
  lập có explicit confirmation và scope file rõ."
- §16.4: Save is a "revision-checked RPC"; Revert is an "Explicit Runner mutation
  có baseline/conflict check".
- §9.6: `workspace.file.write/revert` live on the "workspace mutation lane có
  lock/revision check".
- §11.4: "Local lock áp dụng cả editor save và Git mutation do ứng dụng thực
  hiện."
- §18.2: the runner database holds `file_snapshots` ("Hash/content references và
  retention"); §18.5 governs quotas.
- §17.3: domain errors use `{ error: { code, message, retryable, details? },
  requestId }`; the existing code list includes `FILE_CONFLICT` and
  `WORKSPACE_BUSY`.

## 6. Decisions

### 6.1 Made by the operator

- P3-B includes **both** save and revert.
- Revert restores the **run-start snapshot**, not HEAD.
- Both **per-file** and **whole-workspace** revert ship in P3-B.

### 6.2 My calls (flag these while reading; a builder may revisit only with a
reason written down)

1. **Baseline = the latest run in the workspace.** Snapshots belong to attempts;
   the panel asks the workspace for its newest baseline and labels it with
   `capturedAt` and `attemptId`. If two sessions share a workspace, the baseline
   belongs to the newer run — the label makes that visible. Keying by session
   would be a different product decision.
2. **Save edits an existing regular file only.** `FILE_NOT_FOUND` otherwise.
   Creating files through Save is P3-D/never.
3. **Writes refuse symlinks** rather than following them (`SYMLINK_REFUSED`).
4. **A capture failure fails the run** (`run.failed { error: "snapshot_failed" }`)
   — the same shape as `branch_refused`. A run without a baseline cannot be
   attributed or reverted, and pretending otherwise is worse than refusing to
   start.
5. **Whole-workspace revert is bounded to fit the existing 10 s RPC wait**
   (≤ 300 files, ≤ 16 MiB); larger plans answer `PLAN_TOO_LARGE` and the UI
   tells the operator to revert in smaller pieces. A second, longer waiter is
   the alternative; it is deliberately not built here (see §10).
6. **Deletions in a whole-workspace revert are computed by re-running the same
   collector** used at capture: *collected-now minus manifest* = created during
   the run. Credential files, symlinks and non-regular files are excluded by
   rule in both runs, so they can never enter the delete set.
7. **Caps and retention** (all adjustable by the builder): 1 MiB per file kept,
   64 MiB per snapshot, 10 000 manifest entries, 5 baselines per workspace,
   2 000 status entries per response.
8. **No `workspace.changed` event emission.** The panel refreshes its own view
   after its own mutation; the event type exists in the protocol but has no
   producer and P3-B does not become the first one (it would need an attempt
   context the write lane does not have).
9. **Status is served under the existing `inspect` capability**, because it is a
   read. Writes and reverts are gated by a new `workspace.write` capability.

## 7. Design

### 7.1 Command surface

Existing declarations reused: `CommandKind` already contains
`workspace.file.write` and `workspace.file.revert` in both
`packages/protocol/src/index.ts` and `packages/control-db/src/command-outbox.ts`.
P3-B adds one kind, `workspace.revert`, to both unions (the whole-workspace
mutation; it is a distinct lane use with a distinct payload).

| Purpose | Command kind | Capability | Payload | Result |
|---|---|---|---|---|
| Save a file | `workspace.file.write` | `workspace.write` | `{ op: "file.write", path, content, expectedHash }` | `FileWriteResult` |
| Revert one file | `workspace.file.revert` | `workspace.write` | `{ op: "file.revert", path, expectedHash: string \| null }` | `FileRevertResult` |
| Baseline status | `workspace.inspect` | `inspect` | `{ op: "snapshot.status" }` | `SnapshotStatusResult` |
| Revert the workspace | `workspace.revert` | `workspace.write` | `{ op: "workspace.revert", planDigest }` | `WorkspaceRevertResult` |

`expectedHash === null` means "the caller believes this path does not exist".
`expectedHash` is the SHA-256 hex of the exact file bytes — the same value
`FileReadResult.hash` already returns (`sha256` of the bytes the runner read).

These live in a new `packages/protocol/src/mutation.ts`, and `RpcResultFrame.result`
widens from `InspectResult` to `InspectResult | MutationResult`:

```ts
export type FileWriteResult = {
  op: "file.write"; path: string; hash: string; size: number;
};

export type FileRevertResult = {
  op: "file.revert"; path: string;
  action: "restored" | "deleted" | "none";
  hash: string | null; size: number | null;
};

export type SnapshotEntry = {
  path: string;
  status: "modified" | "created" | "deleted" | "excluded";
  snapshotHash: string | null; currentHash: string | null;
  size: number | null;
  revertable: boolean;
  reason?: string;            // for "excluded": credential, symlink, oversize, unbaselined
};

export type SnapshotStatusResult = {
  op: "snapshot.status";
  baseline: {
    attemptId: string; sessionId: string | null;
    capturedAt: string; partial: boolean; fileCount: number;
  } | null;                    // null = this workspace has no baseline yet
  entries: SnapshotEntry[];
  counts: { modified: number; created: number; deleted: number; excluded: number };
  digest: string | null;       // null when baseline is null or truncated
  truncated: boolean;          // > MAX_STATUS_ENTRIES entries
};

export type WorkspaceRevertResult = {
  op: "workspace.revert"; planDigest: string;
  restored: number; deleted: number;
  failed: { path: string; code: string } | null;
};
```

`mutation.ts` also owns `parseMutationRequest(kind, payload): MutationRequest |
undefined` with strict shape checks (manual validation, matching the inspect
parser's idiom — no Zod in these paths). `parseRpcResultFrame` keeps trusting
`result.op` as today; the handler is the only producer, and the server's
response is a pass-through.

Capabilities are advertised as one list, `RUNNER_CAPABILITIES =
[INSPECT_CAPABILITY, WRITE_CAPABILITY]`, in the hello frame. An older server
reads the array and checks only `includes("inspect")` (`parseCapabilities`
accepts arbitrary non-empty strings), so the extra entry is ignored — extending
the list is compatible in both directions.

New constants in `packages/protocol/src/inspection.ts`:
`WRITE_CAPABILITY = "workspace.write"`, plus the caps from §6.2 call 7
(`MAX_SNAPSHOT_FILE_BYTES`, `MAX_SNAPSHOT_BYTES`, `MAX_SNAPSHOT_ENTRIES`,
`MAX_STATUS_ENTRIES`, `MAX_REVERT_FILES`, `MAX_REVERT_BYTES`,
`SNAPSHOT_RETENTION`).

New error codes (they join §17.3's domain codes — §17.3's list was never
exhaustive, P3-A already added several):

| Code | Meaning | HTTP |
|---|---|---|
| `FILE_CONFLICT` | expected hash ≠ current bytes | 409 |
| `WORKSPACE_BUSY` | a run (or another mutation) holds the workspace lock | 409 |
| `SYMLINK_REFUSED` | the path is a symlink; writes never follow one | 400 |
| `FILE_UNSUPPORTED` | binary, oversize, device/socket, or non-regular | 400 |
| `NO_SNAPSHOT` | this workspace has no captured baseline | 404 |
| `SNAPSHOT_PARTIAL` | the baseline was truncated by caps; bulk revert is unsafe | 409 |
| `REVERT_STALE` | the plan digest no longer matches the tree | 409 |
| `PLAN_TOO_LARGE` | the plan exceeds the apply budget | 409 |
| `SNAPSHOT_INCOMPARABLE` | the collector mode cannot be reproduced (e.g. `.git` disappeared) | 409 |
| `FILE_UNWRITABLE` | the write itself failed (EACCES, ENOSPC, …) — the mutation counterpart of P3-A's `FILE_UNREADABLE` | 502 |

### 7.2 Storage: runner database + content-addressed blobs

Two tables in `packages/runner-db/src/db.ts` (inline `CREATE TABLE IF NOT EXISTS`
like the rest):

```sql
CREATE TABLE IF NOT EXISTS snapshot_runs (
  attempt_id    TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,      -- canonical realpath
  session_id    TEXT,
  collector     TEXT NOT NULL,       -- 'git' | 'walk'
  captured_at   INTEGER NOT NULL,
  partial       INTEGER NOT NULL DEFAULT 0,
  file_count    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS file_snapshots (
  attempt_id    TEXT NOT NULL,
  path          TEXT NOT NULL,       -- workspace-relative
  state         TEXT NOT NULL,       -- 'kept' | 'excluded'
  hash          TEXT,                -- sha256 hex, null when excluded
  size          INTEGER,
  mode          INTEGER,
  reason        TEXT,                -- excluded: credential | symlink | oversize | unbaselined | non_regular
  PRIMARY KEY (attempt_id, path)
);
CREATE INDEX IF NOT EXISTS file_snapshots_hash ON file_snapshots (hash);
```

Content lives under `$CC_WEB_RUNNER_HOME/snapshots/blobs/<sha256>` (directory
0700, files 0600), written once and shared across snapshots — the same bytes in
ten runs occupy one blob. The database never stores file content (§18.2's
"hash/content references": the reference is the blob path derived from the
hash).

Retention: on each capture, keep the newest `SNAPSHOT_RETENTION` (5)
`snapshot_runs` per `workspace_path`; delete older rows and their
`file_snapshots` rows, then delete every blob whose hash is no longer
referenced. Snapshots contain source code (§15.4) and never leave the runner.

New runner-db API (TDD in `packages/runner-db`):

- `recordSnapshot(db, { attemptId, workspacePath, sessionId, collector,
  capturedAt, partial, entries })` — one transaction.
- `latestSnapshot(db, workspacePath)` → run row + entries.
- `pruneSnapshots(db, workspacePath, keep)` → hashes no longer referenced.
- `lockHolder(db, workspacePath)` already exists; add
  `acquireWorkspaceLock(db, workspacePath, holderId): boolean` for the write
  lane (the same `workspace_locks` row, so a run start and a revert cannot
  overlap).

`acquireWorkspaceLock` writes its `holderId` into the existing
`workspace_locks.attempt_id` column: a run stores its attempt id, a mutation
stores a sentinel (`write:<commandId>`, `revert:<commandId>`). No schema change,
and `beginAttempt` / `lockHolder` / `releaseAttempt` keep their behaviour — a
run start during an apply sees the sentinel as the holder and answers
`workspace_busy` through the existing translation.

### 7.3 When the baseline is captured

The hook goes in `executor.ts` **after** the `prepareWorkspace` block
(`apps/runner/src/execution/executor.ts:285-303`) and **before** the router/SDK
stream is built:

1. `run.started` is appended (the run is observable).
2. `prepareWorkspace` runs; a refusal ends the run (`branch_refused`).
3. **capture the baseline** — the checkout has happened, so this is the tree the
   agent first sees.
4. the SDK stream is created.

The capture is a new seam alongside `prepareWorkspace`:
`ExecuteOptions.captureBaseline?: (workspacePath, attemptId) => Promise<{ ok: true } | { ok: false; reason: string }>`,
wired by the daemon to a runner-db-backed implementation. A failure records
`run.failed { error: "snapshot_failed", reason }`, marks the attempt terminal
and returns — the `finally` still releases the lock (same path as
`branch_refused`).

The seam runs **inside `executeRun`'s try block**, after `prepareWorkspace`
succeeds and before the router and the SDK stream are built, so the failure path
is exactly `branch_refused`'s: `state = "failed"`, terminal event written,
`return { state: "failed" }`, `finally` releases the lock. The attempt id is the
one already carried by the parsed command; capture mints no new identifier.

### 7.4 Collector rules (deterministic, shared by capture and status)

`collectBaselinePaths(root)` returns workspace-relative paths of regular files:

- Git work tree: `git ls-files -z --cached --others --exclude-standard` (argv
  array, no shell — §15.2). This naturally skips `.git` and ignored trees
  (`node_modules`, build output) and includes untracked-not-ignored files.
  Collector mode `git`.
- Otherwise: recursive walk skipping `.git` and a fixed list
  (`node_modules`, `dist`, `build`, `.venv`, `__pycache__`, `target`). Collector
  mode `walk`.
- Post-filter both: drop credential basenames (`isRefusedCredentialBasename`),
  drop symlinks and non-regular files. These paths never enter the manifest and
  never enter a delete set.
- Caps: entries beyond `MAX_SNAPSHOT_ENTRIES`, files over
  `MAX_SNAPSHOT_FILE_BYTES`, and bytes beyond `MAX_SNAPSHOT_BYTES` are recorded
  as `state = 'excluded'` with a reason — **recorded, not omitted**, so they can
  never be mistaken for "created during the run". Hitting a byte/entry cap marks
  the run `partial`.

Status re-runs the same collector in the mode recorded on the baseline row. If
the mode can no longer be reproduced (a `git` baseline but no repository now),
status answers `SNAPSHOT_INCOMPARABLE`.

The path helpers (`resolveInsideWorkspace`, `isRefusedCredentialBasename`) move
from `apps/runner/src/inspection/paths.ts` to `apps/runner/src/workspace/paths.ts`
so the snapshot collector and the mutation lane share them without importing an
inspect module. The move is pure relocation — the inspect handler re-imports and
its tests stay unchanged — and it keeps one copy of the credential rule rather
than two that can drift.

### 7.5 Save (`file.write`)

1. Refuse when `lockHolder(db, root)` is set → `WORKSPACE_BUSY`.
2. `resolveInsideWorkspace(root, path)`; then `lstat` the resolved path: must
   exist, be a regular file, not a symlink (`SYMLINK_REFUSED`), pass
   `isRefusedCredentialBasename` (already inside the resolver).
3. Read the current bytes (bounded by `MAX_SNAPSHOT_FILE_BYTES`); if the file
   sniffs binary → `FILE_UNSUPPORTED`; if `expectedHash` ≠ current sha256 →
   `FILE_CONFLICT` (nothing written).
4. `content.length` over the cap → `FILE_UNSUPPORTED`.
5. Atomic write: temp file in the same directory, `mode` copied from the
   existing file, write + `fsync`, `rename` over the target (same filesystem by
   construction). No write ever crosses a symlink — step 2 already refused one,
   and `rename` replaces the link itself rather than following it; step 2's
   `lstat` also closes the TOCTOU window between resolve and rename for the
   final component.
6. `markAnswered` on the server side (the existing inspect retirement path; a
   write, like a read, starts no attempt).

Result: `{ op: "file.write", path, hash: sha256(newBytes), size }`.

### 7.6 Per-file revert (`file.revert`)

Baseline = `latestSnapshot(db, root)`; none → `NO_SNAPSHOT`. Lock held →
`WORKSPACE_BUSY`.

Let `entry` be the manifest row for `path` (if any), `current` the current
bytes (absent if the file does not exist). `expectedHash === null` asserts
absence.

| `entry` | `current` | condition | action |
|---|---|---|---|
| kept | present | `sha256(current) === expectedHash` | write baseline blob atomically (`restored`) |
| kept | absent | `expectedHash === null` | write baseline blob (`restored`) |
| absent (created during run) | present | hash matches | delete the regular file (`deleted`) — never a directory, never a symlink |
| absent | absent | `expectedHash === null` | `none` (idempotent no-op) |
| excluded (this path) | any | — | `FILE_UNSUPPORTED` with the row's reason |
| any | hash mismatch | — | `FILE_CONFLICT` |

Per-file revert does **not** consult the workspace-level `partial` flag: a
`kept` entry is complete on its own, so a partial baseline still allows
per-file restores. `partial` only blocks the whole-workspace apply (§7.8),
where the delete set would be unknowable.

Result: `{ op: "file.revert", path, action, hash, size }` where `hash`/`size`
describe the file now (null after a deletion).

### 7.7 Status (`snapshot.status`, read-only)

1. `latestSnapshot` → `baseline: null` when the workspace has no baseline (a
   normal answer, not an error — the panel says "chưa có baseline").
2. Re-run the collector; build entries:
   - in manifest `kept`, current differs → `modified` (revertable when current
     is a readable regular file under the caps);
   - in manifest `kept`, current absent → `deleted` (revertable);
   - not in manifest, present now → `created` (revertable: deletable);
   - in manifest `excluded` → `excluded` with its reason (never revertable, never
     deletable);
   - current file is a symlink/binary/oversize → `excluded` with a reason.
3. Sort by path, cap at `MAX_STATUS_ENTRIES`, set `truncated`.
4. `digest` = SHA-256 over the baseline `attemptId` and the canonical
   `status\tpath\tsnapshotHash\tcurrentHash` lines, sorted by path. `null` when
   there is no baseline or the list is truncated. A partial baseline still gets
   a digest; the **apply** refuses it, so the panel can show the list with a
   "baseline không đầy đủ" banner.

Content never crosses the wire — only paths, hashes and sizes.

### 7.8 Whole-workspace revert (`workspace.revert`)

Two phases over one read op plus one mutation:

1. **Preview** = `snapshot.status` (§7.7). The panel renders the counts and the
   full list (restores, deletions, conflicts) and the digest.
2. **Apply** carries that digest. The runner recomputes the status internally
   and refuses unless the digest matches (`REVERT_STALE`). Then:
   - `partial` baseline → `SNAPSHOT_PARTIAL`;
   - `truncated` or over `MAX_REVERT_FILES`/`MAX_REVERT_BYTES` →
     `PLAN_TOO_LARGE`;
   - take the lock (`acquireWorkspaceLock` with holder `revert:<commandId>`) —
     busy → `WORKSPACE_BUSY`; release in a `finally`;
   - re-verify each entry's `currentHash` immediately before acting (same table
     as §7.6); on the first failure stop and report
     `failed: { path, code }`, with `restored`/`deleted` counting what already
     applied. The digest is now stale by construction, so the panel reloads the
     status.
   - `excluded` entries are listed in the preview but never touched by apply.

Deletions remove regular files only; empty directories left behind are not
removed (removing them would be a directory deletion the operator never
previewed, and directories are not in the manifest at all). Apply is per-file
atomic but not transactional across files — the honest result shape says which
file stopped it.

### 7.9 Locks and concurrency

- Save, per-file revert and workspace revert each take the workspace lock
  non-blockingly; a run in flight yields `WORKSPACE_BUSY` (§11.4: "Local lock áp
  dụng cả editor save và Git mutation do ứng dụng thực hiện").
- The lock row is the same `workspace_locks` table a run uses, so a run start
  during an apply (`beginAttempt`) observes `workspace_locked` — the two lanes
  cannot interleave.
- Every write/revert re-reads and re-hashes immediately before acting; the
  hash token is the revision fence, the lock is the scheduling fence.

### 7.10 HTTP routes

§17.1 already defines `GET/PUT /api/workspaces/:id/file?path=...`. The other
three are additions (the table never defined a revert endpoint; this is the
call):

| Method | Endpoint | Maps to |
|---|---|---|
| GET | `/api/workspaces/:id/snapshot` | `workspace.inspect { op: "snapshot.status" }` |
| PUT | `/api/workspaces/:id/file?path=...` body `{ content, expectedHash }` | `workspace.file.write` |
| POST | `/api/workspaces/:id/file/revert` body `{ path, expectedHash }` | `workspace.file.revert` |
| POST | `/api/workspaces/:id/revert` body `{ planDigest }` | `workspace.revert` |

All four reuse the inspect route's spine exactly: Origin allowlist → cookie auth
(plain-text 401/403) → `parseCompositeId` → `workspacesForOwner` →
`stateOf === "ready"` → capability gate → `pending.register` → outbox enqueue
with a 15 s expiry → `dispatcher.drain` → the 10 s waiter → `markAnswered` /
`markRejected` / `markRejected("expired")` (Ruling 2 and 16, unchanged).

Differences from the read routes:

- The write routes gate on `WRITE_CAPABILITY` instead of `INSPECT_CAPABILITY`.
- They parse a JSON body first (the `runs-routes.ts` idiom: `request.json()` →
  400 on failure, manual `typeof` checks per field; the path stays a query
  parameter, the body carries `content`/`expectedHash`/`planDigest`).
- They reject request bodies over ~2 MiB before enqueueing (a save above the
  per-file cap can never succeed; refusing at the edge saves a round trip).
- `statusForCode` gains the §7.1 table: `FILE_CONFLICT`/`WORKSPACE_BUSY`/
  `REVERT_STALE`/`SNAPSHOT_PARTIAL`/`PLAN_TOO_LARGE`/`SNAPSHOT_INCOMPARABLE` →
  409, `NO_SNAPSHOT` → 404, `SYMLINK_REFUSED`/`FILE_UNSUPPORTED` → 400,
  `FILE_UNWRITABLE` → 502.
  `retryable` stays code-derived (`RUNNER_UNAVAILABLE` only).

### 7.11 Web panel

**Files tab — editable viewer.** For a text, untruncated file the `<pre>`
becomes a `<textarea>` bound to a `draft` ref initialised from `viewer.content`.
Save is enabled only when `draft !== viewer.content`; it calls `writeFile(id,
path, draft, viewer.hash)`.

- Success: replace `viewer` with the returned `{ path, content: draft, hash,
  size, binary: false, truncated: false }` — the new hash is now the save token,
  so a second edit saves without a reload.
- `409 FILE_CONFLICT`: an inline banner "Tệp đã thay đổi trên đĩa kể từ lúc
  mở." with a "tải lại" button; the draft is kept until the operator chooses.
- `WORKSPACE_BUSY`: "Không thể lưu khi agent đang chạy."
- Truncated/binary/unreadable files keep the read-only presentation and say why
  Save is unavailable.

**Changes tab — two baselines.** A small source switch: `Git (HEAD)` (the
existing `git.changes` + `git.diff` view) and `Từ lúc bắt đầu chạy` (the new
status). The snapshot source shows counts, a banner for a missing/partial/
truncated baseline, and rows `path — sửa/thêm/xoá`, each text row with a
`khôi phục` button behind a one-line confirm; `excluded` rows show the reason
with no button. The header carries `Khôi phục cả workspace`, which opens a
confirmation panel listing the restores, the deletions, the conflicts and the
digest; apply is disabled while the editor holds unsaved changes (§7.11) and
after a `REVERT_STALE` (with "xem lại" reloads).

After any successful mutation the panel reloads only what it owns (the file
viewer, the snapshot status, the git changes) — never the sessions store. The
existing `epoch` guard and per-loader flags cover the races.

**Pure logic** moves into `apps/web/src/features/inspect/edit.ts` (dirty
detection, save-token update) and `.../revert.ts` (count summarisation, row
labels, apply gating), unit-tested with `bun:test` beside them, following the
P3-A module idiom. The component stays wiring only.

**API service**: `inspect-api.ts` gains `writeFile`, `revertFile`,
`revertWorkspace`, `fetchSnapshotStatus`, all through a `mutate<T>(url, method,
body)` helper that mirrors `request()` (never throws; `InspectOutcome`;
`Content-Type: application/json`; same-origin cookie like `runs-api.ts`).
New codes join `MESSAGES` with Vietnamese copy.

### 7.12 Compatibility and observability

- Sessions whose runs predate P3-B have no baseline: status answers
  `baseline: null`, the panel disables the snapshot source and says so. Save
  works regardless (it needs no baseline).
- Old runners do not advertise `workspace.write`; write routes answer
  `503 RUNNER_UNAVAILABLE` through the capability gate, exactly like P3-A.
- Every mutation is an outbox row (`workspace.file.write` / `.revert` /
  `workspace.revert`) retired by `rpc.result` (Ruling 2) or by the expiry path
  (Ruling 16). No new audit table is introduced; snapshot rows are the audit of
  what was baseline.

## 8. Slices (each TDD, one commit; the plan will formalise them)

1. **Protocol** — new kind, capability, four payload/result types, strict
   parsers, caps; unit tests in `packages/protocol`.
2. **Control-db** — `workspace.revert` in the outbox `CommandKind` union;
   fingerprint/dedup behaviour unchanged.
3. **Runner-db** — snapshot tables, `recordSnapshot`/`latestSnapshot`/
   `pruneSnapshots`, `acquireWorkspaceLock`; `:memory:` tests.
4. **Runner: collector + capture** — relocate the path helpers first (pure
   move, suite stays green), then git/walk collection, caps, blob storage,
   retention pruning; tmp-dir tests.
5. **Runner: capture hook** — executor seam after `prepareWorkspace`, failure
   path `run.failed { error: "snapshot_failed" }`, lock released; executor and
   run-controller tests.
6. **Runner: save** — conflict, atomic write, symlink/credential/binary/size,
   lock busy; handler tests through the existing fake-workspace idiom.
7. **Runner: per-file revert** — the §7.6 table; handler tests.
8. **Runner: status + workspace revert** — digest, stale, partial, budget,
   best-effort apply; handler tests.
9. **Runner: daemon wiring** — a third dispatch branch (`isMutationKind`) routes
   `workspace.file.write` / `workspace.file.revert` / `workspace.revert` to the
   new `mutation/handler.ts` (the inspect handler stays DB-free and lock-free;
   the run controller keeps owning `run.start`/`run.cancel`/`approval.respond`),
   and hello advertises `["inspect", "workspace.write"]`.
10. **Server** — four routes, capability gate, status mapping, outbox
    retirement; the `inspect-routes.test.ts` harness (fake runner over
    `dialWebSocket`) is the template.
11. **Web: service** — `mutate` helper + four functions + copies; `bun:test`.
12. **Web: pure modules** — `edit.ts`, `revert.ts`; `bun:test`.
13. **Web: panel** — textarea save, conflict/busy banners, baseline switch,
    per-file revert confirm, workspace-revert panel; build + typecheck.
14. **End** — full gates (`bun test`, typecheck, lint, integration, web build),
    whole-branch review, fix pass, push, ledger/memory update.

## 9. Left to the builder

- Exact SQL parameter shapes and helper names in `packages/runner-db`.
- The canonicalisation of the digest input (any unambiguous encoding works; the
  server never computes it).
- Whether the collector spawns `git` through the existing spawn seam or a new
  one, and how it is faked in tests.
- Panel markup, Tailwind classes and the confirmation dialog's exact copy
  (Vietnamese, matching the existing panel).
- File-size/body-limit numbers at the HTTP edge (a constant is enough).
- Test fixture layout for snapshot blobs (tmp dirs, cleanup).

## 10. Risks and ledger entries opened by this design

- **10 s waiter vs. bulk apply.** The plan is bounded (§6.2 call 5) so the
  existing waiter suffices. If real usage outgrows the budget, the follow-up is
  a second `PendingRpcRequests` with a longer timeout for mutation kinds — a
  slice of its own, not a P3-B patch.
- **Baseline is workspace-latest, not session-scoped** (§6.2 call 1). The label
  makes it visible; revisit only if shared workspaces become common.
- **Git/walk mode drift** answers `SNAPSHOT_INCOMPARABLE` rather than guessing.
- **Capture cost at run start** is bounded by the caps; large workspaces pay a
  one-time scan and mark `partial`.
- **No Idempotency-Key** (§3) — a retried save/revert fails closed with
  `FILE_CONFLICT`; the repo-wide follow-up is ledgered in `TODO.md`.
- **`workspace.changed` remains unproduced** (§6.2 call 8); the panel refreshes
  itself. Browser-wide invalidation is P3-C's business.
