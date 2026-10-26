# Bounded Runner RPC + Read-Only Inspection — Design (P3-A)

> Brainstorm output for the first slice of the roadmap's Phase 3 (Config và
> code review, §23). The owner opted out of the question round ("tự đi đi",
> standing authorization of 2026-10-26), so every ruling below is the
> implementer's call, marked as such, and the whole document is what the
> owner reviews. A builder-check subagent reads this before the plan is
> written.

## Intent and why

Phase 3 as the spec states it — "Diagnostics RPC, profiles/overrides,
CodeMirror, file/Git RPC, revision checks, snapshots, explicit revert và
retention" (§23) — is five features, not one. Taken together they are larger
than M4 and M5 combined, and they are ordered by a dependency the current
codebase does not satisfy at all:

**A browser cannot ask a runner a question.** Commands travel one way, down
the durable outbox (§9.2); only two things travel back up: `command.receipt`,
which says accepted-or-rejected and nothing else (§9.4), and `events`, where
every `RunnerEvent` is required to carry `sessionId`, `runId` and
`attemptId` (§12.1) and is journaled and broadcast as session content. A file
read, a `git status`, a config diagnostic — none of these is a run, none has
a session sequence, and none is something the journal should ever hold.

So Phase 3's real first problem is not files or diffs. It is a **bounded
request/response channel over the runner socket**, and then the read-only
half of §15.2/§8.3 that proves the channel end to end without any mutation
risk. That is this milestone. Write, revert, snapshots, profiles and the
editor are named, ordered and deferred below.

## Phase 3 sub-roadmap (all the implementer's calls)

| Slice | Scope | Depends on |
| --- | --- | --- |
| **P3-A — this document** | Bounded RPC channel (`rpc.result`); read-only inspection: `file.list`, `file.read`, `git.changes`, `git.diff`, `config.inspect` diagnostics; read-only web panels (plain rendering, no editor) | — |
| **P3-B** | Workspace mutations: `file.write` with expected-hash revision check and atomic write; `file.revert` with baseline/conflict check; run-start snapshots + retention | P3-A |
| **P3-C** | Profiles and overrides: `Override<T>`, `config_profiles` CRUD endpoints (§17.1), dispatch integration so a profile's overrides land in `run.start` | independent; could swap with P3-B |
| **P3-D** | CodeMirror review UI: `CodeEditor.vue`, `SplitDiff.vue`, `UnifiedDiff.vue`, `ReviewToolbar.vue`; draft/local-revision conflict UI (§16.3, §16.4) | P3-A + P3-B |

Order rationale: the channel enables every later slice; reads before writes
is the only safe order to build a mutation surface on top of; the editor is
the presentation layer that consumes A and B, so it comes last. P3-C is the
one slice with no dependency on the channel, which is why it may move.

## Goals

- A browser can ask a runner a question and get a bounded, redacted answer,
  correlated to the request, with no mutation and no journal pollution.
- The answer arrives over the existing authenticated runner socket — no new
  port, no second auth path, no trust of server-supplied paths.
- An offline or silent runner fails the HTTP request in bounded time instead
  of holding it (§17.1: "Không giữ HTTP request vô hạn khi Runner offline").
- The four read surfaces work against the real workspace of a real runner:
  directory listing, file content, git working-tree status, git diff, plus
  redacted config diagnostics.
- Every path is contained and every credential file is refused by the runner
  itself, whatever the server asked for (§15.2).

## Non-goals (P3-A, stated for later)

- No writes, no revert, no commit, no `git reset`/`clean`/`stash` anywhere.
- No run-start snapshots or diff baselines beyond HEAD → working tree
  (§15.4 baseline 1 only; baselines 2 and 3 are P3-B).
- No CodeMirror, no merge view, no editor drafts — panels render plain text.
- No profiles, no `Override<T>`, no `config_profiles` HTTP surface (P3-C).
- No editing of `.claude/settings.json` on a runner (§8.4 is a later phase).
- No general capability negotiation (§6.4). The one exception is the minimal,
  fail-safe inspect capability in Ruling 13 — the builder-check showed that
  without it a new server can make an old runner spawn a run (see there).

## Anti-goals — what would make this a failure

- Any inspect result written into the session journal, the session sequence,
  or the browser's event stream. An inspection is not session content; if it
  reaches the journal, replay bounds and `sessionSequence` are corrupted.
- Trusting a path because the server sent it. The runner re-checks
  containment against its own registration for every request (§15.2).
- A path reaching a shell string. Every git invocation is an argv array with
  an explicit cwd, through the existing spawner (§15.2).
- Returning raw config, environment, or credential material to the server —
  diagnostics are resolved and redacted on the runner (§8.3).
- An HTTP request that waits forever, or an outbox row that accumulates
  forever, when the runner is gone.
- A frame that closes the socket or wedges the message loop when a runner
  sends a result the server did not expect.

## Rulings (all the implementer's calls)

### 1. A new wire frame, `rpc.result`, carries the answer — not an event

The runner answers an inspect command with a frame that is **not** an event:

```ts
type RpcResultFrame = {
  type: "rpc.result";
  commandId: string;            // correlates to the inspect command
  ok: boolean;
  result?: InspectResult;       // present when ok
  error?: { code: string; message: string };
};
```

Why not an event: §12.1 requires every event to name a run, and §12.2 gives
every event a session sequence, an ACK watermark and a broadcast. An
inspection is none of those; folding it into the event family would either
force a synthetic session/run (polluting placement, the journal and replay)
or add a second, non-session event class inside a table whose constraints
assume sessions (§18.3). A fourth return-frame type beside `command.receipt`,
`events` and `reconcile` keeps the journal's invariants untouched. This is
the same reasoning the M4 brainstorm used when it deferred a live branch
query — it just now decides how that RPC will eventually be built.

The frame is additive: a server that does not know it refuses it as
`unknown_message` (existing behaviour), and a runner never sends it unless
it received an inspect command. Protocol version stays 1 (§17.4, additive).

### 2. Inspections are durable commands, and they expire fast

The inspect request goes through the existing outbox and inbox like every
other command (§9.6 puts `workspace.inspect`/`config.inspect` in exactly
those command classes). It is enqueued, drained, delivered, and persisted to
the runner's inbox like a command, and its answer comes back on
`rpc.result`.

It carries `expiresAt = issuedAt + 15 s`. That is the difference between a
command and a run: §9.5's "do not start hours later" applies with full force
to a question whose asker is a live HTTP request. A runner that reconnects
after the window finds the command already retired by `retireExpired`, which
is correct — the browser has long since been told the runner was unavailable.

**`rpc.result` is the sole answer to an inspect command; there is no
receipt.** This resolves the two problems the builder-check found in the
receipt path:

- The gateway rejects any receipt whose `attemptId` is empty
  (`runner-gateway.ts:517-526`), and an inspect has no attempt. Sending
  `attemptId: ""` would make a legitimate frame look malformed; making
  `attemptId` optional would edit a validated frame two directions of the
  upgrade must agree on.
- With only a result, waiter termination is unambiguous: exactly one
  `rpc.result` arrives per inspect, and it *both* retires the outbox row and
  settles the HTTP request. A refusal (`ok: false`) is that same frame, so a
  refused inspect returns its real error code immediately instead of hanging
  the full 10 s.

The runner still writes the inbox row before answering (§9.3 step 4: persist,
then answer), and a duplicate delivery recomputes and re-sends the result —
a read is idempotent, so re-answering costs a recomputation and changes
nothing. The row is retired server-side when `rpc.result` arrives; if the
runner dies first the row stays pending, is redelivered on reconnect, and
expires at 15 s like any command.

Both halves are bounded on the same clock: the HTTP handler waits at most
10 s, the command expires at 15 s. The 5 s of headroom means a slow-but-alive
runner can still answer after the browser gave up; the answer then arrives at
a registry with no waiter and is dropped (§3) — harmless for a read.

### 3. The server keeps an in-memory pending-request registry

A new module holds `Map<commandId, { resolve, reject, timer }>`. The HTTP
handler registers before draining, awaits, and on timeout rejects with
`RUNNER_UNAVAILABLE`. The gateway gains an `onRpcResult` hook wired to the
registry, exactly as `onReceipt` is wired to the dispatcher.

In-memory, not durable, and that is honest: the waiter is an HTTP request
whose lifetime cannot exceed the process's. A server restart drops the
waiter and the browser's fetch fails; the browser retries. Persisting a
waiter would only create a record nothing can ever honour.

A result for an unknown `commandId` (the request timed out, or a duplicate
arrives) is **dropped, not an error frame** — unlike a receipt for an unknown
command, this is an expected race, and answering it with an error would turn
a normal timeout into a socket-level event.

### 4. One inspect command kind per scope, discriminated by payload

`workspace.inspect` stays one `CommandKind` (§9.1, already defined), with a
payload discriminated on `op`; `config.inspect` stays its own kind.

```ts
type WorkspaceInspectRequest =
  | { op: "file.list"; path: string }      // "" = workspace root
  | { op: "file.read"; path: string }
  | { op: "git.changes" }
  | { op: "git.diff"; path: string };
```

Four kinds was the alternative; one kind with an `op` discriminator matches
the protocol's existing granularity (the union already names
`workspace.inspect`) and keeps the outbox's `kind` column a small closed set.

`config.inspect` **does carry a `workspaceId`** — the name is about which
subsystem answers, not about scope. The builder-check caught the contradiction
in an earlier draft: a diagnostics report needs a `workspaceRoot` and resolves
project/local sources relative to a workspace cwd (§7.2), so there is no
coherent workspace-less report when the runner serves several. Its envelope
therefore sets `workspaceId` exactly as `workspace.inspect` does, the runner
resolves it through the same `workspacePathFor` seam (Ruling 11), and the
endpoint is per-workspace as Ruling 10 states. Diagnostics about the *runner*
itself that no workspace can host — missing helper binaries, provider auth —
become runner-scoped fields inside that report, not a second endpoint.

Both request and result are parsed as untrusted on arrival (the existing
`asValidatedEvents` / `asCommandEnvelope` pattern): a malformed request is
refused by the runner with `unsupported_command`; a malformed result is
dropped by the server with a log, never written anywhere.

### 5. The runner refuses any command kind it does not implement

**This is a real defect P3-A must fix, not just a new feature.** Today the
run controller's `handle` treats every kind that is not `run.cancel` or
`approval.respond` as a **run start**: it falls through to `beginAttempt`.
Sending an unfamiliar command kind to a current runner would try to launch it
as a coding agent against a locked workspace. P3-A adds an explicit kind
switch — `run.start`, `run.cancel`, `approval.respond`, `workspace.inspect`,
`config.inspect` — and anything else answers `accepted: false, reason:
"unsupported_command"` before any inbox or attempt side effect (§9.3 step 2:
validate the command class before touching it). Cheap, and it makes the
additive-frame decision in Ruling 1 safe during a rolling upgrade.

### 6. Read-only inspection takes no workspace lock; a run never blocks a read

The workspace lock (`workspace_locks`, §11.4) exists to serialise **writers**.
An inspect is a reader, and taking the lock would mean an operator cannot
inspect a workspace for the entire duration of a long run — the opposite of
the feature's purpose. So `workspace.inspect` and `config.inspect` never
acquire it and never create an attempt row; they run inline in the command
handler and answer from the file system.

The cost is a possible torn read of a file an agent is mid-write. That is
acceptable and detectable: the result carries a hash of the bytes actually
returned, so any later revision-checked operation (P3-B) sees the mismatch
rather than trusting a partial read. Taking the lock instead would trade a
rare, detectable inconsistency for a guaranteed denial of service on the
inspect surface.

### 7. Path safety is a runner-side function with a fixed shape

One module, one entry point, applied to every `path` in every inspect op
(this is what P3-B will reuse for writes). Rules, in order:

1. Reject absolute paths, empty paths where a path is required, and any
   segment of `..`.
2. Compose `resolve(workspaceRoot, relativePath)` and then `realpath` the
   result; require the realpath to be inside `realpath(workspaceRoot)`.
3. Require the target's stat to be a regular file for reads and a directory
   for listings; anything else (device, socket, fifo) is refused.
4. Refuse credential files by basename, case-insensitively: `*.pem`,
   `*.key`, `id_rsa*`, `id_ed25519*`, `.credentials.json`, `.netrc`,
   `.npmrc`, `identity.json`, and `.env` / `.env.*`.

Rule 2 resolves symlinks before the containment check, so a symlink pointing
outside the root is refused. This is not a complete TOCTOU defence — a
symlink swapped between the `realpath` and the `open` can still race — and
the design says so rather than pretending otherwise: the runner's OS user
owns the workspace, so an attacker able to swap symlinks there already holds
the runner's privileges, and `openat(O_NOFOLLOW)` would be Linux-specific
complexity for a threat the trust model (§2.1) does not include.

Rule 4 refuses `.env` content. The spec's §15.2 is explicit — "Không expose
app data, auth keys hay credential files qua file browser" — and an `.env` is
a credential file. It still **appears in listings**; only its content is
refused, with a clear error, so the operator learns it is there without the
browser becoming a secrets reader. Marked as my call, and easy to relax to a
warning if the owner would rather read them.

### 8. Every result is bounded, and the bounds say what they are

| Surface | Bound | Above the bound |
| --- | --- | --- |
| Directory listing | 2000 entries | `truncated: true`, first 2000 |
| File content | 1 MiB | `content` is the first 1 MiB, `truncated: true` |
| Binary file | NUL byte in the first 8000 bytes (git's heuristic) | `binary: true`, `content: null` |
| Git changes | 2000 entries | `truncated: true`, first 2000 |
| Git diff text | 256 KiB | `diff` truncated, `truncated: true` |
| HTTP waiter | 10 s | 503 `RUNNER_UNAVAILABLE` |
| Command expiry | 15 s | retired by `retireExpired` (Ruling 16) |

`git.changes` needs its own cap, not just the diff's: a working tree with
tens of thousands of changed paths is a real repository state (a generated
directory that is not ignored), and an uncapped status is exactly the
unbounded RPC this milestone exists to prevent.

`hash` is the SHA-256 of the bytes actually returned. For a truncated file
that is a prefix hash, not a full-file token — fine while nothing can be
saved (§15.4 baseline 3 is P3-B, where the save token must be the full-file
hash; noted there). Keeping the two apart now avoids shipping a hash that
looks like a save token but is not.

### 9. Diagnostics are resolved and redacted on the runner, and never carry secrets

`config.inspect` with `op: "diagnostics"` returns a fixed, redacted report:

```ts
type DiagnosticsReport = {
  protocolVersion: number;
  runtime: string;               // e.g. "bun 1.4.3" — process.versions, no paths
  workspaceRoot: string;
  sources: Array<{ source: "user" | "project" | "local";
                   path: string; exists: boolean; readable: boolean }>;
  gitAvailable: boolean;
  providerAuth: "configured" | "missing" | "unknown";
  warnings: string[];
};
```

`sources` resolves §7.2's three locations relative to the workspace cwd
(project and local are cwd-relative; user is `$HOME`-based) and reports
existence and readability only. `providerAuth` is a presence check — it
answers "is there credential material this run would use", never the value.
No environment dump, no raw settings JSON, no file contents (§8.3: "Không
truyền toàn bộ env/raw config lên Server"). The report goes through the same
redaction the run pipeline already uses where any string could be a path or
token; the structure above is chosen so most fields cannot carry a secret by
construction. Static only: it never calls a model (§8.3), so there is no cost
and no consent question.

`runtime` deliberately reports versions without paths: a path is a weak
secret, but a server-side operator does not need `$HOME` to understand a
diagnostic, and omitting it is free.

### 10. The HTTP surface is spec-shaped, JSON-errored, and never cached

Endpoints, following §17.1's paths:

```
GET /api/workspaces/:id/files?path=<rel>
GET /api/workspaces/:id/file?path=<rel>
GET /api/workspaces/:id/changes
GET /api/workspaces/:id/diff?path=<rel>
GET /api/workspaces/:id/config/diagnostics
```

`:id` is the **URL-encoded composite `<runnerId>/<workspaceId>`**, matching
the composer's existing composite project value, and unambiguous by
construction: `workspaces` is keyed `(runner_id, workspace_id)` (§18.1), so a
bare `workspaceId` (commonly `default`) can collide across runners. The
server splits on the first `/`; a `workspaceId` containing `/` is refused as
malformed. All five require the owner to own that runner (§19.2) and send
`Cache-Control: no-store` (§19.4) — file content and diagnostics are both
identity-bearing.

Auth failures stay plain text (`401`/`403`), matching every existing route
whose tests already pin that convention. **Domain** failures use §17.3's JSON
`ApiError` shape with codes `RUNNER_UNAVAILABLE`, `WORKSPACE_NOT_FOUND`,
`WORKSPACE_AMBIGUOUS` (unresolvable composite), `PATH_OUTSIDE_WORKSPACE`,
`FILE_NOT_FOUND`, `FILE_UNREADABLE`, `CREDENTIAL_FILE_REFUSED`,
`DIAGNOSTICS_UNAVAILABLE`. Retrofitting the older routes to the JSON model is
explicitly out of scope; the inconsistency is deliberate and ledgered.

The server checks `runnerGateway.stateOf(runnerId) === "ready"` **before**
enqueuing, so the common offline case answers `503` immediately instead of
through the 10 s waiter. The waiter is the backstop, not the fast path.

### 11. The runner resolves the path from its own registration, not the request

The command's `workspaceId` is resolved through the runner's existing
`workspacePathFor` seam (the same one `run.start` uses), so a workspace the
runner no longer serves is `unknown_workspace` and never a server-supplied
path. The server's `path` (from `GET /api/workspaces`) is display metadata;
the runner never treats it as authoritative (§15.1: "Không gửi arbitrary
`cwd`"). A workspace that is registered but whose directory has vanished
answers `FILE_UNREADABLE`/`WORKSPACE_NOT_FOUND` from a stat, not a crash.

### 12. The web panels are read-only, render plain text, and live on the session view

P3-A ships the surfaces that make the channel visible, deliberately without
CodeMirror (§16.3 is P3-D):

- A **Files** tab: a flat, breadcrumbed listing (the runner returns one
  directory per call — no recursive tree RPC in P3-A) and a viewer that shows
  file content in a `<pre>`, with banners for `binary`, `truncated`, and
  refused-credential files.
- A **Changes** tab: `git.changes` as a list, `git.diff` as an underlined
  text diff — add/remove lines tinted with existing theme tokens, no merge
  view, no accept/reject controls (§16.4: those default to "changes editor
  state only" and there is no editor yet, so they do not appear).
- A **Diagnostics** section alongside them: the redacted report, rendered as a
  labeled list.

**Where they live: the session view's secondary panel, not a new route.**
§16.1's layout already names a "Secondary panel: Files / Changes / Code /
Diff" beside the conversation. `SessionView` gains a tab strip in its right
column (collapsing to a tabs/stacked layout on narrow screens, matching
§16.1's mobile guidance). A standalone `/workspaces/...` browser is
deliberately out of scope: it is the same surfaces with a different entry
point, and the session pin is the honest source of "which workspace am I
looking at".

**The pin is not in the session list today, so P3-A adds it.** A correction
found while planning: `SessionSummary` (`packages/control-db/src/replay.ts`)
is derived from `run_events` and `active_runs` and carries no
`workspaceId`/`runnerId`, so the composite id Ruling 10 needs is *not*
already in hand. The pin exists in the `sessions` table (§2.3, ADR-006) and
is readable via `sessionPin(db, sessionId)`; P3-A adds `runnerId` and
`workspaceId` to `listSessions`'s answer with a `LEFT JOIN sessions`, both
nullable. Nullable is correct, not defensive: a session dispatched before
the pin milestone has no row, and the panel then says "workspace unknown for
this session" rather than guessing. The rail already loads this list, so the
panel reads the pin from the store it already has — no new request on the
common path.

Pure mapping/formatting logic — path breadcrumbs, diff line classification,
size formatting, composite-id encoding — lives in testable
`apps/web/src/features/**` modules so `bun test` covers them (SFCs cannot be
unit-tested here, per [[tailwind-over-scoped-css]] and the known `.vue` gap).
All plain Tailwind utilities in the existing view idiom.

One directory per call is a real constraint worth stating: a recursive tree
would be an unbounded RPC, and the bound in Ruling 8 is what keeps the
channel honest. The panel fetches on demand as the operator descends.

### 13. The hello declares a minimal `inspect` capability, and the server gates on it

**The builder-check found a genuine hazard here.** The additive-frame
argument (Ruling 1) makes the *server* safe against an unknown inbound frame,
but the dangerous direction is new-server → **old** runner: today's
`RunController.handle` treats every unrecognised kind as a run start, so a
`workspace.inspect` naming a known workspace (`"default"`) would
`beginAttempt`, take the workspace lock, and spawn an SDK run with an empty
prompt — writing junk into the journal. Ruling 5's explicit refusal only
protects runners built *after* P3-A.

`negotiateHello` (`packages/protocol/src/handshake.ts`) already receives a
free-form `runnerVersion` (`daemon.ts:52-63`) and parses nothing from it, and
the server has no capability store. Rather than lean on a version string
whose semantics are informal, the hello gains one optional, additive field:

```ts
// RunnerHello
capabilities?: string[];   // absent = [] (pre-P3-A runners)
```

Validated exactly like `workspaces`: absent means empty; present but not an
array of non-empty strings is a malformed hello. The server stores it on the
connection and `GET /api/workspaces/:id/...` returns `503
RUNNER_UNAVAILABLE` for an inspect when the runner's capabilities do not
include `"inspect"` — the same answer an offline runner gives, so the browser
needs no new branch. This is deliberately *not* general capability
negotiation (§6.4 stays out of scope): it is one boolean fact, in the one
place the server already receives runner-declared data.

The alternative — assume server and runner always upgrade together — was
rejected because the repo's own release path (per-platform binaries via the
runner-build workflow) makes a mismatched pair the normal case, not the
exception.

### 14. The runner emits `rpc.result` through a widened command handler

The builder-check noted the runner's only outbound seam is
`ReconnectLoop.#handleCommand`, which sends exactly the receipt its handler
returns; `RunController` has no socket reference. Two shapes were possible:
give the controller a `sendResult` callback, or widen the handler's return.

**Chosen: widen the handler's return type.** `CommandHandler` returns
`{ receipt: CommandReceipt; results?: RpcResultFrame[] }` instead of a bare
receipt; the loop sends the receipt first, then any results. Why:

- It keeps the socket in exactly one module (the loop), preserving the
  layering that lets the controller be tested with no network — the same
  property the reconnect-loop comment already claims.
- It keeps result frames in the same place their trigger is, so the
  controller stays the single owner of "what a command does".
- A callback would put a send on the same call stack as IO it does not own
  and make ordering between receipt and result an emergent property.

Ordering is fixed: receipt (if any) before result. An inspect emits **no
receipt** (Ruling 2), so for an inspect the result is the only frame; for the
existing kinds the results array is empty and behaviour is byte-identical.
The empty-prompt run hazard is closed by Ruling 5 regardless of ordering.

The result frame is dropped by the loop if it cannot be sent (no ready link);
the server's waiter then times out with `RUNNER_UNAVAILABLE` and the outbox
row expires — the same bounded failure as any transport loss.

### 15. Read-only inspection is dispatched outside the run/attempt machinery

The `RunController` exists to own attempts, locks and SDK lifecycle. An
inspect touches none of those (Ruling 6), so it does not go through
`RunController.handle` at all. The daemon's `onCommand` gains a thin
pre-switch: an inspect kind is handed to a new
`apps/runner/src/inspection/handler.ts` (path safety, stat, read, git via
`gitSpawn`, redaction) which returns the result frame; everything else goes
to `runs.handle` unchanged. This is what makes Ruling 5's explicit
`unsupported_command` refusal natural — the pre-switch recognises exactly
three kinds (`workspace.inspect`, `config.inspect`, and the run/approval
kinds delegated onward).

### 16. Expired inspect rows are swept per-request and bounded, not by a timer

The builder-check's sharpest operational catch: `retireExpired` runs only at
the top of `Dispatcher.drain(runnerId)` for one runner, and nothing in the
control server drains on a timer. The `stateOf === "ready"` pre-check
(Ruling 10) narrows the window but is racy — a runner that goes offline
between the check and the enqueue leaves a `pending` inspect row no drain
will revisit.

**Ruling: every inspect enqueue is followed by a bounded self-cleanup, and
the HTTP handler already bounds the wait, so residue is impossible.** The
handler, on timeout, calls `outbox.markRejected(commandId, "expired")`
directly — the waiter and the row are retired by the same event, on the same
10 s clock, with no dependency on a future drain. `retireExpired` stays the
backstop for rows whose handler was interrupted (process killed mid-request),
and P3-A adds **no** background timer: a periodic sweep for a surface that
already self-cleans per request would be complexity with no failure it fixes,
and §20.6's observability wants timers to mean something.

Accepted residue, stated rather than hidden: a server killed in the <1 ms
between enqueue and registering the waiter leaves one `pending` row that
expires on the next drain of that runner or is retired by any later
inspect's sweep. That is a bounded, self-healing residue, not the unbounded
accumulation the anti-goal forbids.

## What is left to the plan

- Exact file/module layout, TDD order, and the RED→GREEN sequence per layer
  (protocol → runner → server → web), each with its own tests.
- The precise parser functions and their adversarial cases (malformed
  results, wrong types, oversized frames, `commandId` mismatch, unknown op).
- Whether the plan executes in one wave or two (protocol+runner+server
  first, web panels second) — the design does not depend on the answer.
- `runtime`/version sourcing: the runner has no build id today; the plan
  picks the cheapest honest source (generated constant vs. `process.versions`)
  or omits the field. `runnerVersion` already exists in the hello for the
  capability gate (Ruling 13), so this is only about the report's own field.
- The `git.changes` entry shape and status vocabulary: **there is no
  structured status parser to reuse** — `apps/runner/src/git/checkout.ts` does
  a one-line dirty check only. The plan pins the shape with tests against a
  real repository (porcelain v1 `--porcelain -z` is the cheap, stable choice;
  decoded to `{ path, status: "added"|"modified"|"deleted"|"renamed"|"untracked", origPath? }`).
- Test seams for the new server registry and the runner inspect handler, in
  the existing style (injected clock, scripted spawner, in-memory db).
- The exact wording and set of the `capabilities` strings (Ruling 13); the
  design fixes only `"inspect"`.

## Appendix — grounding recon (2026-10-26, base `cc06e7a`)

- The only inbound runner frames are `hello`, `reconcile`, `command.receipt`,
  `events` (`runner-gateway.ts` switch) — no request/response exists.
- `RunnerEvent` requires `sessionId`/`runId`/`attemptId`; ingestion
  (`ingestEvent`) allocates a `sessionSequence` and the browser gateway
  broadcasts it. An inspect result cannot be an event without corrupting
  both.
- `RunController.handle` currently falls through to `beginAttempt` for any
  unrecognised kind — the defect in Ruling 5.
- `CommandKind` already lists `workspace.file.write/revert`,
  `workspace.inspect`, `config.inspect`; nothing handles the last two.
- `workspaces` PK is `(runner_id, workspace_id)`; `workspacesForOwner` joins
  `runners` and returns `runnerId` alongside `workspaceId`, which is what the
  composite `:id` mirrors.
- The M4 git work already provides `gitSpawn` (argv arrays, cwd, timeout with
  SIGTERM→SIGKILL escalation) and a porcelain parser to build on.
- `redactErrorText` / key-name redaction exist in `apps/runner/src/execution/redact.ts`.
- No `registered_workspaces` writer exists yet; the runner's workspace→path
  seam is `defaultWorkspaceResolver`, env-derived (`CC_WEB_RUNNER_DEFAULT_WORKSPACE`),
  so `workspace.inspect` reuses `workspacePathFor` unchanged.
