# P3-D — CodeMirror review UI

Status: accepted for implementation 2026-11-01. The owner skipped the
interview ("cứ làm"); the decisions below are the builder's calls and are
recorded so the plan can argue from them.

## 1. Intent

P3-A shipped read-only inspection with plain rendering; P3-B added
revision-checked saves, baseline reverts and run-start snapshots on top of a
bare `<textarea>`. The roadmap's P3-D row is the presentation layer those two
slices deliberately deferred: `CodeEditor.vue`, `SplitDiff.vue`,
`UnifiedDiff.vue`, `ReviewToolbar.vue`, plus the draft/local-revision conflict
UI from ARCHITECTURE §16.3–§16.4. ADR-010 stays binding: a review-first surface,
not a full IDE.

The reviewer's job is: see what the agent changed, accept or reject pieces of
it, and only then write the result to the Runner — never the other way round.

## 2. Goals

- The Files tab edits and views file content in CodeMirror, with language
  highlighting by file extension, dirty tracking and the existing
  revision-checked save.
- The Changes tab's git source shows a merge view of HEAD → working tree with
  per-chunk accept/reject, unified by default and split when the surface is
  wide enough.
- The review actions carry §16.4's exact meanings: **Reviewed** (local marker,
  no second apply), **Save** (revision-checked `file.write` of the document the
  reviewer settled on), **Revert** (explicit mutation to the run-start baseline,
  labelled as such). **Commit** is deliberately absent — it is a separate git
  operation with no RPC in this product.
- Draft conflict: an agent/external change to a file that has a dirty draft is
  never applied over the draft; the operator chooses.
- Editor and language packs lazy-load; the main bundle does not grow with
  CodeMirror. Theming uses the generated shadcn-vue variables, so light/dark
  follow the existing `.dark` class.
- All logic that can be pure is a pure module under `apps/web/src/features/`
  and is unit-tested (`bun test`); no SFC compiler exists in the test runtime,
  so components themselves stay thin.

## 3. Non-goals

- No git commit/stage/checkout RPC and no commit control.
- No persistent "reviewed" state across reloads — it is a session-local marker.
- No baseline-content read RPC. The snapshot tab keeps its list + revert UI;
  the merge view is the **git source only**. Reading snapshot blobs for a
  content diff is a later slice.
- No file watching or streaming. Conflicts are detected on save (the runner's
  `FILE_CONFLICT`) and when a file is explicitly re-opened or refreshed.
- No "accept all / reject all" toolbar actions in MVP — per-chunk controls only.
- No editing of `.claude/settings.json` (§8.4 remains a later phase).
- No change to the protocol, the control server or the runner. P3-D is web-only.

## 4. Constraints

- The secondary panel is `lg:w-[420px]` beside the journal and a 288px-tall
  stacked strip on narrow screens (`SessionView.vue`). Split diff will usually
  be cramped here; the toggle exists for wide/future layouts.
- `git.diff` is capped at `MAX_DIFF_BYTES` (256 KiB) and truncation cuts bytes,
  possibly mid-line; `file.read` is capped at `MAX_FILE_BYTES` (256 KiB) and
  reports `truncated`.
- A `git diff -- <path>` for one path can still be: a binary notice
  (`Binary files … differ`), a rename that emits two file headers, or an empty
  string. Only single-file text diffs can become a merge view.
- Shadcn-generated files (`components/ui/**`, `lib/utils.ts`, `styles/index.css`,
  `components.json`) are never edited; the theme comes from their variables.
- Gates: `bun test`, `bun run typecheck`, `bun run lint`,
  `cd apps/web && bun run build`.

## 5. Decisions

### 5.1 Dependencies

Added to `apps/web/package.json` (workspace root `bun.lock` updated by
`bun add`):

- `codemirror`, `@codemirror/state`, `@codemirror/view`,
  `@codemirror/language`, `@codemirror/commands`, `@codemirror/merge`
- `@lezer/highlight` — imported directly for the `tags` namespace; `@codemirror/language` does not re-export it.
- language packs: `@codemirror/lang-javascript`, `@codemirror/lang-json`,
  `@codemirror/lang-markdown`, `@codemirror/lang-python`,
  `@codemirror/lang-html`, `@codemirror/lang-css`

Each component is loaded through `defineAsyncComponent(() => import(...))`
from `InspectPanel.vue`, so CodeMirror lands in its own chunks. Language packs
are dynamic imports keyed by extension, cached as one promise per language,
and applied through a `Compartment` so the editor does not need recreation
when a language arrives.

### 5.2 Diff → documents

`parseUnifiedDiff(text)` (pure) turns a single-file unified diff into its
hunks: `-` lines belong to the original only, `+` lines to the modified only,
context lines to both, `\ No newline at end of file` adjusts the preceding
side's final newline, and each hunk keeps its old/new start and counts. It
returns `null` for:
empty text, binary notices, more than one `diff --git` header, hunk headers
that do not parse, or hunk counts that disagree with the body. A `null` parse
or `diff.truncated === true` falls back to today's tinted `<pre>`
(`classifyDiffLines`) with an explicit notice — never a merge view built from
a partial document.

The working side of the merge view is **`readFile`'s content**, not the
diff's `modified` text: `readFile` is authoritative and carries the hash a
save must present. A default-context `git diff` carries only its hunks, so the
parser's own `original` is a fragment; `spliceOriginal(parsed, modified)`
(pure) rebuilds the full HEAD side by checking each hunk's new-side range
against the read document and swapping it for the hunk's old-side lines. If
that check fails (the diff and the read no longer agree, e.g. a race between
the two RPCs) the view falls back to the plain-text diff. When `readFile`
fails (deleted file) the view renders read-only from the reconstructed pair
(original vs empty), with Save disabled and Revert available only when the
snapshot says the file is revertable. A binary or truncated read never offers
a merge view.

### 5.3 Review semantics (§16.4 mapping)

| Control | Meaning | Implementation |
| --- | --- | --- |
| Reviewed | The operator has looked at this exact diff; nothing is applied twice | Session-local key set `path + "\0" + hash`; a new hash is unreviewed by construction. No request. |
| Save | Write the document the reviewer settled on | Existing `PUT /file` with `expectedHash`; from the diff view the saved content is the merge editor's document |
| Revert | Explicit Runner mutation to the run-start baseline | Existing `file.revert`, inline confirm, label names the baseline; disabled when the snapshot has no baseline or the entry is not revertable; revision precondition is the entry's currentHash, the same guard the snapshot list uses |
| Commit | A git operation, not an app action | Absent from the UI |

The merge editor's mutable "original" is never the audit baseline: the
original is reconstructed from the Runner's diff, and Revert always goes
through the Runner's own baseline/conflict check.

### 5.4 Conflict UI

`resolveIncoming(current, incoming, draft)` (pure) decides what a fresh
`file.read` means for an open editor:

- no draft → adopt;
- draft not dirty against the current viewer → **adopt**: viewer fields
  refresh and the draft becomes the new content;
- dirty and `incoming.hash === current.hash` → **adopt, keep draft**: the
  viewer fields (hash, size) refresh, the unsaved draft stays (still dirty,
  no conflict);
- dirty and a different hash → **conflict**: keep viewer + draft, remember the
  incoming read.

A conflict banner replaces the save-error line and offers exactly two
explicit choices: **load the new version** (discard the draft, adopt
incoming) and **overwrite with my draft** (re-read the file to obtain the
freshest hash, then `file.write` the draft; a second conflict keeps the
banner). The same banner appears when a save returns `FILE_CONFLICT`: the
client then fetches the current file to fill the incoming side. Nothing is
ever overwritten silently, and the draft is never replaced by a refetch.

### 5.5 Components

New directory `apps/web/src/components/review/`:

- **`CodeEditor.vue`** — props `{ modelValue: string; path?: string;
  readOnly?: boolean; minHeight?: string }`, emits `update:modelValue`.
  Creates the view once in `onMounted` on a plain `shallowRef` (never a deep
  proxy), destroys it in `onBeforeUnmount`, pushes external `modelValue`
  changes with a transaction (skip when equal), and sets read-only through
  `EditorState.readOnly` + `EditorView.editable` extensions, not by disabling
  a button.
- **`UnifiedDiff.vue`** — props `{ original: string; modified: string;
  editable: boolean; path?: string }`, emits `update:modified`. One `EditorView`
  whose doc is `modified`, plus `unifiedMergeView({ original, mergeControls:
  editable, gutter: true, collapseUnchanged: { margin: 3, minSize: 4 },
  syntaxHighlightDeletions: false })`. Deleted-chunk widgets carry the
  built-in accept/reject controls.
- **`SplitDiff.vue`** — same props/emits, uses `MergeView` with `a = original`
  (read-only) and `b = modified` (editable per `editable`),
  `revertControls: "a-to-b"`, `gutter: true`, `collapseUnchanged`. The control
  copies the original chunk into the editable document — the one Save writes;
  `"b-to-a"` would only edit the read-only original and leave the saved
  document untouched. Both diff
  components highlight the modified side's language through the same cached
  dynamic import and `Compartment` pattern as `CodeEditor.vue`, driven by the
  `path` prop. All three editor components set `EditorState.lineSeparator`
  from the incoming text (`lineSeparatorFor`), so a CRLF document round-trips
  through editing and Save byte for byte.
- **`ReviewToolbar.vue`** — props `{ reviewed, canSave, canRevert, saving,
  dirty, revertHint?: string }`, emits `toggle-reviewed`, `save`, `revert`.
  shadcn-vue `Button`s with lucide icons; disabled reasons live in `title`
  and helper text. No Commit button.
- A shared `features/review/theme.ts` defines the CodeMirror theme and a
  `HighlightStyle` whose classes are styled by the same theme, all from
  `var(--background)`, `var(--foreground)`, `var(--border)`,
  `var(--muted-foreground)`, `var(--primary)`; The merge views keep
  `@codemirror/merge`'s built-in diff tints; a CodeMirror-internal emerald/red
  pair would be a custom palette, which the project forbids. The `<pre>` fallback
  keeps its Tailwind emerald/red line tints.

### 5.6 Layout

The diff header gains a mode toggle (`Một cột` / `Hai cột`) and a
`đã duyệt` badge. `defaultDiffMode(containerWidth)` returns `"split"` at
`>= 720px`, `"unified"` below — §16.1's mobile default. The container width
comes from a `ResizeObserver`; an explicit choice overrides the width-derived default until the session changes, and remains switchable at any time.

The Files tab keeps its save row but renders `<CodeEditor v-model="draft">`
instead of the `<textarea>`; binary or truncated files keep the existing
notice and plain rendering (no draft is created for them today, and none is
created now).

### 5.7 Files

New:

- `apps/web/src/features/review/unified-diff.ts` + `.test.ts`
- `apps/web/src/features/review/review-state.ts` + `.test.ts`
  (`resolveIncoming`, `defaultDiffMode`, reviewed-key helpers)
- `apps/web/src/features/review/languages.ts` + `.test.ts`
- `apps/web/src/features/review/theme.ts`
- `apps/web/src/components/review/CodeEditor.vue`
- `apps/web/src/components/review/UnifiedDiff.vue`
- `apps/web/src/components/review/SplitDiff.vue`
- `apps/web/src/components/review/ReviewToolbar.vue`

Modified:

- `apps/web/package.json`, `bun.lock`
- `apps/web/src/components/InspectPanel.vue`

### 5.8 Testing

Pure modules are unit-tested with `bun test`:

- `parseUnifiedDiff`: single hunk, multiple hunks, new file (empty original),
  deleted file (empty modified), no-newline marker on either side, context
  between hunks, empty/binary/multi-file/malformed → `null`.
- `spliceOriginal`: a partial-context diff spliced into the read document,
  hunks separated by unchanged lines, a hunk with no added lines, CRLF
  content, a missing trailing newline on the original side, a read document
  that no longer matches → `null`.
- `resolveIncoming`: the four cases of §5.4 (adopt / adopt-keep-draft /
  conflict).
- `lineSeparatorFor`: LF → `null`, CRLF and mixed text → `"\r\n"`.
- `defaultDiffMode`: 420 → unified, 720 → split, 1024 → split.
- `languages.ts`: extension mapping (case-insensitive, `.d.ts`, unknown →
  plain), one loader per id.
- reviewed keys: same path+hash reviewed, new hash unreviewed.

Components are verified through `typecheck`, `lint` and the production build
(they are dynamically imported, so a broken import shows up in the build
chunk graph); the logic they rely on is the tested pure modules.

### 5.9 Out of scope, recorded

- Compare view of a conflict (server version vs draft) — the banner plus
  adopt/overwrite is the MVP; a side-by-side conflict diff can reuse
  `SplitDiff` later.
- Persistent review state, commit control, snapshot-content diffs,
  "accept all/reject all".
