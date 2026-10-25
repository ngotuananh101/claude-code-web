# Branch Select, Real — Design (M4)

> Brainstorm output for the roadmap's M4. The owner opted out of the
> question round ("tự đi đi", standing roadmap authorization of 2026-10-26);
> every ruling below is the implementer's call, marked as such, and the whole
> document is what the owner reviews.

## Intent and why

The composer's branch select is decorative today: a hardcoded `main` item
that travels nowhere. An operator starting a session wants the run to happen
on a chosen branch of the project they picked — without SSH-ing into the
runner to `git checkout` first. M4 makes the selection real end to end:
the runner reports the branches each workspace actually has, the control
plane places and validates the choice, and the runner switches the working
tree — under the workspace lock, and only when doing so cannot destroy
anything.

## Goals

- The composer offers the real branch list of the selected project.
- A chosen branch is enforced by the runner at run start: the run either
  starts on that branch or fails with a reason the operator can act on.
- A branch choice never silently lands the run on a different branch.

## Non-goals (M4 and stated for later)

- No worktree mode, snapshots, revert, or commit surfaces (§15.3–§15.5 later
  phases; the owner's call).
- No live branch query RPC — branches ride the declaration and refresh on
  reconnect (see Ruling 1).
- No branch *creation*; only existing branches.
- No branch switching for existing sessions — the selector lives on the
  new-session screen alone, like the project and runner selectors.
- No pin change: the session pin stays `(workspace, runner)` (ADR-006).

## Anti-goals — what would make this a failure

- Any path that runs `git reset`, `git clean`, `git stash`, `checkout -f`,
  or `checkout -- .` to "make the tree switchable". The refusal IS the
  product: dirty state is the operator's to resolve.
- Auto-committing or discarding pre-existing edits.
- A branch name reaching a shell string instead of an argv element (§15.2).

## Rulings (all the implementer's calls)

### 1. Branches ride the workspace declaration

`DeclaredWorkspace` gains optional `branches?: string[]`. The runner lists
them itself (`git for-each-ref` in the workspace path) and re-lists on every
reconnect, because the daemon's `declaredWorkspaces` option becomes
array-or-thunk, resolved when each hello/reconcile frame is built. The
control plane stores them with the declaration rows and serves them on
`GET /api/workspaces`.

Why not a live query RPC: the runner socket has no request/response surface
today (commands are one-way with receipts); building one is a milestone of
its own. Staleness is bounded by "since the last reconnect" and is safe
because the declaration is only used to *narrow placement* — the runner
re-verifies at checkout (Ruling 3) and refuses a branch that no longer
exists. The lister reads `refs/heads/` only (Ruling 3 defines "branch" as
a local head); a listing failure — git missing, not a repository —
declares no branches rather than failing the boot.

Parse rules (protocol, pinned by tests): absent field stays absent
(back-compat with older runners); present but not an array of non-empty
strings is a malformed hello (same strictness as the rest of the shape);
entries longer than 256 characters are malformed; more than 200 entries
keep the first 200 (a big repo stays connectable; the dropdown is unusable
past that anyway); duplicates keep the first occurrence. The runner-side
lister applies the same caps so a well-behaved runner never trips the
malformed path.

### 2. Dispatch: branch is a per-run payload field, validated against declarations

`POST /api/runs` accepts optional `branch` (non-empty string). Rules:

- A branch without a real workspace declaration in the same body is a 400
  (`bad request`): a branch is a property of a workspace, and the composer
  only sends it alongside `workspaceId`.
- The name must match `^[A-Za-z0-9][A-Za-z0-9._/-]*$` and fit 256
  characters — defense in depth; the runner enforces the same.
- Placement narrows exactly like `workspaceId` does (§15.1): the candidates
  are the owner's runners that declare **both** the workspace and the
  branch. Nobody declares it → 400 `unknown_branch`. A placement that
  cannot work is a client error even when every runner happens to be down.
- A pinned session validates the branch against the **pinned** runner's
  stored declaration; not declared → 400 `unknown_branch`. The pin itself
  is untouched: branch is a per-run choice like `model`, not part of where
  the session lives.
- The branch rides the `run.start` payload next to `model` — never an
  envelope field, never a URL or argv fragment.

### 3. The runner's checkout gate — the safety core

At run start, after the workspace lock is held and after `run.started` is
durably appended, before the SDK stream is built, the runner runs the gate
(`apps/runner/src/git/`, new). With no branch in the payload: **no git
spawn at all** — current behavior, byte for byte. With a branch, in order:

1. **Name shape** — the same regex/length as the route; anything else is
   refused `invalid_branch_name` (argv safety even though argv arrays
   never interpolate).
2. **Dirty check** — `git status --porcelain`; any line not starting with
   `?? ` (untracked files are left alone by checkout and are not ours to
   judge) refuses `dirty_tree`. No stash, no clean, no reset. The operator
   decides what to do with their edits. A non-zero exit here is not
   "dirty" — it is git itself refusing (a non-repo path, a broken
   repository), and refuses `checkout_failed`.
3. **Branch exists — as a local head** — `git rev-parse --verify --quiet
   refs/heads/<name>` failing refuses `unknown_branch` (the declaration
   was stale; the honest answer is refusal, not a nearest-match guess).
   Verifying the fully-qualified ref is load-bearing: bare `rev-parse
   <name>` would accept tags and `origin/main`, and `git checkout
   origin/x` detaches HEAD while `git checkout x` with only `origin/x`
   existing DWIM-*creates* a local branch — both violate the goals, so
   the gate only ever checks out a ref it proved lives under
   `refs/heads/`.
4. **Checkout** — `git checkout <name>`; a non-zero exit or a 10-second
   timeout refuses `checkout_failed`. No retry, no force, no
   `--track`/`-b` of any kind.

"A branch" therefore means **a local head, nothing else**. A fresh clone
declares only its default branch — honest, because those are the branches
that exist locally. Checking out a remote-only branch (`origin/x`) would
require creating a local tracking branch, which is branch creation: an
owner-level scope decision explicitly out of M4. Tags and detached-HEAD
runs are not offered at all.

Every spawn is an argv array with `cwd` set to the workspace — no shell,
no interpolation (§15.2). A refusal appends `run.failed` with
`{ error: "branch_refused", reason, branch }` and the attempt finishes
`failed` with the lock released through the executor's existing `finally`.
A checkout appends one honest `run.status { action: "checkout", branch }`
row before the run proceeds. If the gate passes but the branch was already
checked out, the same single row records it — the journal does not
distinguish "switched" from "already there".

The gate is injected into the executor (`prepareWorkspace` option, like
`sdk`), so the whole lifecycle is testable with a fake spawner, and pinned
by two real-git integration tests (clean switch, dirty refusal).

### 4. Storage and serving

`workspaces` table gains `branches TEXT NOT NULL DEFAULT '[]'` (JSON
array; `CREATE TABLE` for new databases, `addColumnIfMissing` for existing
ones). The declarative replace on hello/reconcile rewrites it wholesale.
`workspacesForOwner` returns `branches: string[]`, parsing defensively
(`[]` on malformed JSON — the writer is ours, but reads never throw). The
dispatch route narrows candidates from the same parsed rows rather than a
JSON1 SQL predicate: an owner's runner set is small, and one read path
beats two.

### 5. Composer

The branch select lists "Hiện tại" (default — **nothing travels**, the
same rule as "Mặc định" for the model) plus the selected project's declared
branches in mono. A project without declarations (legacy runner, non-repo
workspace) offers only "Hiện tại". Changing the project resets a branch
that the new project does not declare, mirroring the project-reset watch.
The hardcoded `main` item is deleted.

### 6. Journal

The checkout row renders as today's generic event row (type + payload). A
prettier branch row is ledger polish, not M4 scope.

## What is left to the plan

Task order, exact test lists per module, the fake-spawner seam shape, and
whether the two real-git tests live in `git/` or `execution/` — all
mechanical, decided by the plan.
