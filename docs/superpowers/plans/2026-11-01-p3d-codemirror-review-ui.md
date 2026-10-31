# P3-D CodeMirror Review UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace cc-web's plain-text file editor and diff rendering with CodeMirror 6 (`CodeEditor`, `UnifiedDiff`, `SplitDiff`, `ReviewToolbar`) and add the draft/revision conflict UI, per the P3-D roadmap row.

**Architecture:** Web-only slice. Pure logic (diff→documents, conflict resolution, diff-mode selection, language mapping) lives in tested modules under `apps/web/src/features/review/`; thin asynchronous Vue components under `apps/web/src/components/review/` mount and destroy CodeMirror views. `InspectPanel.vue` wires them to the existing P3-A/P3-B RPC surface — no protocol, server or runner change.

**Tech Stack:** Vue 3 SFC, CodeMirror 6 (`codemirror`, `@codemirror/merge`, official language packs), shadcn-vue components (generated files untouched), Bun test, Vite build.

**Spec:** `docs/superpowers/specs/2026-11-01-p3d-codemirror-review-ui-design.md`

## Global Constraints

- Never edit, lint or format `apps/web/src/components/ui/**`, `apps/web/src/lib/utils.ts`, `apps/web/src/styles/index.css`, `apps/web/components.json`.
- The generated-file protection override in `biome.json` stays last; do not touch `biome.json`.
- No change to `packages/protocol`, `apps/control-server` or `apps/runner` — this slice is the web app only.
- `bun` is not on PATH in tool shells: `export PATH="$HOME/.ponta/bin:$PATH"` before every bun/command invocation.
- Conversation in Vietnamese; code, comments, docs and commit messages in English.
- Tests: `bun test <file>` while working; the full gate at the end is `bun test`, `bun run typecheck`, `bun run lint`, and `cd apps/web && bun run build`.
- Commit only the files a task names, with explicit pathspecs: `git add <file>` then `git commit <file> -m "…"`.
- All CodeMirror imports are used only from the async-loaded components; pure modules must not import CodeMirror runtime values (types only) so `bun test` never needs a DOM.
- The theme uses only the generated shadcn variables (`var(--background)`, `var(--foreground)`, `var(--border)`, `var(--muted-foreground)`, `var(--primary)`); diff tints reuse the emerald/red pair already used by `InspectPanel.vue`'s diff `<pre>`.

## Review Focus

These are the input classes the spec implies but no single task's happy path exercises; each owning task adds the named test or verification.

1. **Truncated or malformed diff** — a 256 KiB-capped diff can end mid-line, be a binary notice, or span two file headers; the UI must fall back to plain text rather than render a merge view from a partial document (Task 2 tests `null`; Task 9 renders the fallback).
2. **No trailing newline / CRLF content** — the `\ No newline at end of file` marker must adjust exactly one side, and CRLF bytes must survive the round trip (Task 2 tests).
3. **Conflict race** — a save that returns `FILE_CONFLICT` followed by "overwrite with my draft" must re-read the file before writing; a second conflict must keep the banner and never silently overwrite (Task 3 tests the decision; Task 8 wires the second read).
4. **Stale async responses** — switching files/sessions while a diff, file read, or language pack is in flight must not write into the new view (Task 9 keeps the existing `epoch` guard around both new requests; verification is the guard being used by `openDiff`).
5. **Huge or non-text content** — a near-limit file in CodeMirror and a binary/deleted file in the diff must not offer an editable merge view or a Save that the Runner will refuse (Task 9's editable predicate, verified against `readFile` flags).

---

### Task 1: CodeMirror dependencies and language mapping

**Files:**
- Modify: `apps/web/package.json`, `bun.lock`
- Create: `apps/web/src/features/review/languages.ts`
- Test: `apps/web/src/features/review/languages.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type LanguageId = "javascript" | "json" | "markdown" | "python" | "html" | "css";
  export function languageForPath(path: string): LanguageId | null;
  export function loadLanguage(id: LanguageId): Promise<import("@codemirror/state").Extension>;
  ```
  `languageForPath` maps a workspace-relative POSIX path by extension, case-insensitively, and returns `null` for anything unrecognised. `loadLanguage` dynamically imports and caches one language pack per id; it returns a promise of a CodeMirror extension.

- [ ] **Step 1: Add the dependencies**

Run from `apps/web`:

```bash
export PATH="$HOME/.ponta/bin:$PATH"
cd apps/web
bun add codemirror @codemirror/state @codemirror/view @codemirror/language @codemirror/commands @codemirror/merge \
  @codemirror/lang-javascript @codemirror/lang-json @codemirror/lang-markdown \
  @codemirror/lang-python @codemirror/lang-html @codemirror/lang-css
```

Expected: `apps/web/package.json` gains the dependencies, `bun.lock` updates, exit 0. Nothing under `components/ui/**` changes.

- [ ] **Step 2: Write the failing test**

`apps/web/src/features/review/languages.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { languageForPath } from "./languages.ts";

describe("languageForPath", () => {
  test("maps the supported extensions case-insensitively", () => {
    expect(languageForPath("src/app.ts")).toBe("javascript");
    expect(languageForPath("src/App.TSX")).toBe("javascript");
    expect(languageForPath("src/index.mjs")).toBe("javascript");
    expect(languageForPath("types/index.d.ts")).toBe("javascript");
    expect(languageForPath("tsconfig.json")).toBe("json");
    expect(languageForPath("README.md")).toBe("markdown");
    expect(languageForPath("tools/run.PY")).toBe("python");
    expect(languageForPath("public/index.html")).toBe("html");
    expect(languageForPath("styles/app.css")).toBe("css");
  });

  test("returns null for unknown or extensionless paths", () => {
    expect(languageForPath("Makefile")).toBeNull();
    expect(languageForPath("src/notes.txt")).toBeNull();
    expect(languageForPath(".gitignore")).toBeNull();
    expect(languageForPath("src/widget.yaml")).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test apps/web/src/features/review/languages.test.ts`
Expected: FAIL — cannot resolve `./languages.ts` / export not found.

- [ ] **Step 4: Implement `languages.ts`**

Rules:

- Lowercase the path, take the segment after the last `.`.
- `.d.ts` (and `.d.tsx`? No — only `.d.ts`) → `javascript`.
- `ts, tsx, js, jsx, mjs, cjs, mts, cts` → `javascript`; `json, jsonc` → `json`;
  `md, markdown` → `markdown`; `py, pyi` → `python`; `html, htm` → `html`; `css` → `css`.
- Anything else → `null`.
- `loadLanguage` keeps `const loaders: Record<LanguageId, () => Promise<Extension>>` and a `Map<LanguageId, Promise<Extension>>` cache:
  ```ts
  javascript: async () => (await import("@codemirror/lang-javascript")).javascript(),
  json:       async () => (await import("@codemirror/lang-json")).json(),
  markdown:   async () => (await import("@codemirror/lang-markdown")).markdown(),
  python:     async () => (await import("@codemirror/lang-python")).python(),
  html:       async () => (await import("@codemirror/lang-html")).html(),
  css:        async () => (await import("@codemirror/lang-css")).css(),
  ```
  Import `type { Extension } from "@codemirror/state"` only — a type import keeps the test runtime free of DOM-dependent modules.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test apps/web/src/features/review/languages.test.ts`
Expected: PASS (2 tests, 0 fail). Then `bun run typecheck` — expected clean.

- [ ] **Step 6: Commit**

```bash
export PATH="$HOME/.ponta/bin:$PATH"
git add apps/web/package.json bun.lock apps/web/src/features/review/languages.ts apps/web/src/features/review/languages.test.ts
git commit apps/web/package.json bun.lock apps/web/src/features/review/languages.ts apps/web/src/features/review/languages.test.ts -m "feat(web): add CodeMirror deps and review language mapping"
```

---

### Task 2: Unified-diff → document parser

**Files:**
- Create: `apps/web/src/features/review/unified-diff.ts`
- Test: `apps/web/src/features/review/unified-diff.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ParsedUnifiedDiff = { original: string; modified: string };
  export function parseUnifiedDiff(diff: string): ParsedUnifiedDiff | null;
  ```
  Returns the two full documents reconstructed from one `git diff -- <path>`, or `null` when the text is not exactly one complete single-file text diff.

- [ ] **Step 1: Write the failing test**

`apps/web/src/features/review/unified-diff.test.ts` covers every row of the spec's §5.8 list:

```ts
import { describe, expect, test } from "bun:test";
import { parseUnifiedDiff } from "./unified-diff.ts";

const twoHunks = [
  "diff --git a/a.ts b/a.ts",
  "index 1111111..2222222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
  "@@ -20,2 +21,2 @@",
  "-old line",
  "+new line",
  " tail",
  "",
].join("\n");

test("reconstructs both full documents across multiple hunks", () => {
  const parsed = parseUnifiedDiff(twoHunks);
  expect(parsed).not.toBeNull();
  expect(parsed!.original).toBe("const a = 1;\nconst b = 2;\nconst d = 5;\nold line\ntail\n");
  expect(parsed!.modified).toBe(
    "const a = 1;\nconst b = 3;\nconst c = 4;\nconst d = 5;\nnew line\ntail\n",
  );
});

test("a new file has an empty original side", () => {
  const parsed = parseUnifiedDiff(
    ["diff --git a/new.ts b/new.ts", "new file mode 100644", "--- /dev/null", "+++ b/new.ts",
      "@@ -0,0 +1,2 @@", "+one", "+two", ""].join("\n"),
  );
  expect(parsed).toEqual({ original: "", modified: "one\ntwo\n" });
});

test("a deleted file has an empty modified side", () => {
  const parsed = parseUnifiedDiff(
    ["diff --git a/gone.ts b/gone.ts", "deleted file mode 100644", "--- a/gone.ts", "+++ /dev/null",
      "@@ -1,2 +0,0 @@", "-one", "-two", ""].join("\n"),
  );
  expect(parsed).toEqual({ original: "one\ntwo\n", modified: "" });
});

test("the no-newline marker adjusts only the side it follows", () => {
  const parsed = parseUnifiedDiff(
    ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@",
      "-old", "\\ No newline at end of file", "+new", ""].join("\n"),
  );
  expect(parsed).toEqual({ original: "old", modified: "new\n" });
});

test("context lines outside hunks belong to both sides", () => {
  const parsed = parseUnifiedDiff(
    ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -2,2 +2,2 @@", " keep", "-old", "+new", " tail", ""].join("\n"),
  );
  expect(parsed).toEqual({ original: "keep\nold\ntail\n", modified: "keep\nnew\ntail\n" });
});

test("returns null for text that is not one complete text diff", () => {
  expect(parseUnifiedDiff("")).toBeNull();
  expect(parseUnifiedDiff("Binary files a/x.png and b/x.png differ\n")).toBeNull();
  expect(
    parseUnifiedDiff(
      ["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1 +1 @@", "-x", "+y",
       "diff --git a/c b/c", "--- a/c", "+++ b/c", "@@ -1 +1 @@", "-z", "+w", ""].join("\n"),
    ),
  ).toBeNull();
  expect(parseUnifiedDiff("@@ -1 +1 @@\n-x\n+y\n")).toBeNull(); // no file headers
  expect(
    parseUnifiedDiff(["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1,2 +1,2 @@", "-x", "+y", ""].join("\n")),
  ).toBeNull(); // hunk counts do not match the body
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/web/src/features/review/unified-diff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `parseUnifiedDiff`**

Algorithm (no CodeMirror imports):

1. Split on `"\n"`; drop a single trailing empty element (diff output ends with `\n`). Empty input → `null`.
2. Reject immediately if any line contains `"Binary files"` or starts with `"GIT binary patch"`.
3. Ignore leading header lines until the first `@@`; count `diff --git ` occurrences — more than one → `null`. A hunk before any file header → `null`.
4. For each `@@ -a[,b] +c[,d] @@` hunk, parse the counts (missing count means 1). Walk following lines until counts are exhausted or another `@@`/file header/end appears:
   - `" "` → push `line.slice(1)` to both sides, decrement both counters;
   - `"-"` → original only, decrement old;
   - `"+"` → modified only, decrement new;
   - `"\\"` → mark the last pushed line on its side as "no trailing newline";
   - anything else → `null`.
   If the counts are not exactly exhausted → `null`; if the body stops early → `null`.
5. Join each side's lines with `"\n"`, then append `"\n"` to each side that has lines and whose last line is not marked no-newline. A side with no lines is `""`.
6. A diff with headers but zero hunks → `null`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/web/src/features/review/unified-diff.test.ts`
Expected: PASS (6 tests, 0 fail). `bun run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/review/unified-diff.ts apps/web/src/features/review/unified-diff.test.ts
git commit apps/web/src/features/review/unified-diff.ts apps/web/src/features/review/unified-diff.test.ts -m "feat(web): parse unified diffs into full review documents"
```

---

### Task 3: Review-state pure logic

**Files:**
- Create: `apps/web/src/features/review/review-state.ts`
- Test: `apps/web/src/features/review/review-state.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function defaultDiffMode(containerWidth: number): "unified" | "split";
  export function resolveIncoming(input: {
    currentHash: string;
    incomingHash: string;
    draftDirty: boolean;
  }): "adopt" | "conflict";
  export function reviewKey(path: string, hash: string): string;
  export function isReviewed(
    reviewed: ReadonlySet<string>,
    path: string,
    hash: string,
  ): boolean;
  ```
  `defaultDiffMode` → `"split"` at width ≥ 720, `"unified"` below. `resolveIncoming` implements spec §5.4 exactly at the decision level.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { defaultDiffMode, isReviewed, resolveIncoming, reviewKey } from "./review-state.ts";

test("defaultDiffMode prefers unified on a 420px panel and split when wide", () => {
  expect(defaultDiffMode(420)).toBe("unified");
  expect(defaultDiffMode(719)).toBe("unified");
  expect(defaultDiffMode(720)).toBe("split");
  expect(defaultDiffMode(1024)).toBe("split");
});

test("a clean draft always adopts a fresh read", () => {
  expect(resolveIncoming({ currentHash: "h1", incomingHash: "h1", draftDirty: false })).toBe("adopt");
  expect(resolveIncoming({ currentHash: "h1", incomingHash: "h2", draftDirty: false })).toBe("adopt");
});

test("a dirty draft with an unchanged hash adopts the viewer without a conflict", () => {
  expect(resolveIncoming({ currentHash: "h1", incomingHash: "h1", draftDirty: true })).toBe("adopt");
});

test("a dirty draft whose file changed on the runner conflicts", () => {
  expect(resolveIncoming({ currentHash: "h1", incomingHash: "h2", draftDirty: true })).toBe(
    "conflict",
  );
});

test("reviewed keys are path- and hash-scoped", () => {
  const reviewed = new Set([reviewKey("src/a.ts", "h1")]);
  expect(isReviewed(reviewed, "src/a.ts", "h1")).toBe(true);
  expect(isReviewed(reviewed, "src/a.ts", "h2")).toBe(false);
  expect(isReviewed(reviewed, "src/b.ts", "h1")).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/web/src/features/review/review-state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `review-state.ts`**

Split threshold `720` as a named constant; `reviewKey` joins with `"\u0000"` (a path can contain a space, never NUL); no other logic.

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test apps/web/src/features/review/review-state.test.ts`
Expected: PASS (5 tests, 0 fail).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/review/review-state.ts apps/web/src/features/review/review-state.test.ts
git commit apps/web/src/features/review/review-state.ts apps/web/src/features/review/review-state.test.ts -m "feat(web): add review-state decisions for diff mode, conflicts and reviewed keys"
```

---

### Task 4: Theme and `CodeEditor.vue`

**Files:**
- Create: `apps/web/src/features/review/theme.ts`
- Create: `apps/web/src/components/review/CodeEditor.vue`

**Interfaces:**
- Consumes: `languageForPath`, `loadLanguage` (Task 1).
- Produces:
  - `theme.ts`: `export const reviewTheme: Extension; export const reviewHighlighting: Extension; export const reviewBaseExtensions: Extension[]` (theme + line numbers? decide: line numbers on, highlight active line off in diff context? Keep `reviewBaseExtensions = [reviewTheme, reviewHighlighting, EditorState.allowMultipleSelections? no]`).
  - `CodeEditor.vue` props `{ modelValue: string; path?: string; readOnly?: boolean }`, emits `update:modelValue: [value: string]`.

- [ ] **Step 1: Write the theme module**

`theme.ts` imports `EditorView`, `HighlightStyle` from `@codemirror/view`, `syntaxHighlighting`, `tags` from `@codemirror/language`:

- `reviewTheme = EditorView.theme({ "&": { backgroundColor: "var(--background)", color: "var(--foreground)", fontSize: "12px" }, ".cm-content": { fontFamily: "var(--font-mono, ui-monospace, monospace)", caretColor: "var(--primary)" }, ".cm-cursor": { borderLeftColor: "var(--primary)" }, ".cm-gutters": { backgroundColor: "var(--background)", color: "var(--muted-foreground)", border: "none" }, ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--foreground) 6%, transparent)" }, ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--primary) 20%, transparent)" }, ".cm-token-keyword": { color: "var(--primary)", fontWeight: "600" }, ".cm-token-string": { color: "var(--foreground)" }, ".cm-token-comment": { color: "var(--muted-foreground)", fontStyle: "italic" }, ".cm-token-number": { color: "var(--primary)" }, ".cm-token-function": { color: "var(--foreground)" } })`.
- `reviewHighlighting = syntaxHighlighting(HighlightStyle.define([{ tag: tags.keyword, class: "cm-token-keyword" }, { tag: [tags.string, tags.special(tags.string)], class: "cm-token-string" }, { tag: [tags.lineComment, tags.blockComment, tags.docComment], class: "cm-token-comment" }, { tag: [tags.number, tags.bool, tags.null], class: "cm-token-number" }, { tag: [tags.function(tags.variableName), tags.definition(tags.function(tags.variableName))], class: "cm-token-function" }]))`.
- `reviewBaseExtensions = [reviewTheme, reviewHighlighting]`.
- No `dark` flag: every color is a CSS variable, and `.dark` swaps the variables.

- [ ] **Step 2: Implement `CodeEditor.vue`**

Skeleton (fill in the marked bodies):

```vue
<script setup lang="ts">
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { languageForPath, loadLanguage } from "@/features/review/languages.ts";
import { reviewBaseExtensions } from "@/features/review/theme.ts";

const props = defineProps<{ modelValue: string; path?: string; readOnly?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const host = ref<HTMLElement | null>(null);
const view = shallowRef<EditorView | null>(null);
const languageCompartment = new Compartment();
const readOnlyCompartment = new Compartment();

function readOnlyExtensions(readOnly: boolean): Extension {
  return readOnly
    ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
    : [];
}

onMounted(() => { /* create EditorView with doc = props.modelValue, extensions: [lineNumbers(), keymap.of(defaultKeymap), ...reviewBaseExtensions, languageCompartment.of([]), readOnlyCompartment.of(readOnlyExtensions(!!props.readOnly)), EditorView.updateListener.of((u) => { if (u.docChanged) emit("update:modelValue", u.state.doc.toString()); })], parent: host.value! */ });

watch(() => props.modelValue, (value) => {
  const current = view.value;
  if (current !== null && value !== current.state.doc.toString()) {
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } });
  }
});

watch(() => props.readOnly, (readOnly) => { view.value?.dispatch({ effects: readOnlyCompartment.reconfigure(readOnlyExtensions(!!readOnly)) }); });

watch(() => props.path, (path) => { /* load language if known and reconfigure languageCompartment */ }, { immediate: false });

onBeforeUnmount(() => { view.value?.destroy(); view.value = null; });
</script>

<template>
  <div ref="host" class="min-h-[12rem] overflow-auto rounded-md border border-border/60 bg-background/60" />
</template>
```

Language load rule: on mount and on path change, `const id = path ? languageForPath(path) : null; if (id !== null) void loadLanguage(id).then((ext) => view.value?.dispatch({ effects: languageCompartment.reconfigure(ext) }));` — guard against a stale promise after unmount by checking `view.value !== null`; a stale path's language arriving is harmless (it only styles text), but skip when the id no longer matches `languageForPath(props.path)`.

- [ ] **Step 3: Verify**

Run: `bun run typecheck && bun run lint && cd apps/web && bun run build`
Expected: all clean; the build produces a separate chunk for the editor (dynamic import lands when Task 8 wires it; a static import in the build is fine for this task).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/review/theme.ts apps/web/src/components/review/CodeEditor.vue
git commit apps/web/src/features/review/theme.ts apps/web/src/components/review/CodeEditor.vue -m "feat(web): add CodeMirror theme and CodeEditor component"
```

---

### Task 5: `UnifiedDiff.vue`

**Files:**
- Create: `apps/web/src/components/review/UnifiedDiff.vue`

**Interfaces:**
- Consumes: `reviewBaseExtensions` (Task 4), `languageForPath/loadLanguage` (Task 1).
- Produces: props `{ original: string; modified: string; editable: boolean; path?: string }`, emits `update:modified: [value: string]`.

- [ ] **Step 1: Implement the component**

- `onMounted`: create one `EditorView` whose `doc` is `props.modified`, extensions:
  `lineNumbers(), keymap.of(defaultKeymap), ...reviewBaseExtensions, unifiedMergeView({ original: props.original, mergeControls: props.editable, gutter: true, collapseUnchanged: { margin: 3, minSize: 4 }, syntaxHighlightDeletions: false }), readOnlyCompartment.of(readOnlyExtensions(!props.editable)), languageCompartment.of([]), updateListener` emitting `update:modified` on `docChanged`.
- `unifiedMergeView` comes from `@codemirror/merge`.
- Watch `original`: if it changes, destroy and rebuild the view (a new diff is a new document pair; recreating is simpler and correct).
- Watch `modified`: push a transaction only when the incoming string differs from the doc (guards the emit→prop loop).
- Watch `editable`: reconfigure the read-only compartment.
- `onBeforeUnmount`: destroy.
- Root element: `class="max-h-80 overflow-auto rounded-md border border-border/60 bg-background/60"`; CodeMirror scrolls internally (`.cm-editor { height: 100% }` via `reviewTheme`? Add a local `<style>` `.cm-editor { max-height: inherit; }` if needed — the wrapper's `max-h-80` plus CodeMirror's natural height scrolls the wrapper).

- [ ] **Step 2: Verify**

Run: `bun run typecheck && bun run lint && cd apps/web && bun run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/review/UnifiedDiff.vue
git commit apps/web/src/components/review/UnifiedDiff.vue -m "feat(web): add unified merge-view component"
```

---

### Task 6: `SplitDiff.vue`

**Files:**
- Create: `apps/web/src/components/review/SplitDiff.vue`

**Interfaces:**
- Consumes: `reviewBaseExtensions` (Task 4).
- Produces: same props/emits as `UnifiedDiff.vue`.

- [ ] **Step 1: Implement the component**

- `onMounted`: `new MergeView({ a: { doc: props.original, extensions: [lineNumbers(), ...reviewBaseExtensions, EditorState.readOnly.of(true), EditorView.editable.of(false)] }, b: { doc: props.modified, extensions: [lineNumbers(), keymap.of(defaultKeymap), ...reviewBaseExtensions, readOnlyCompartment.of(readOnlyExtensions(!props.editable)), updateListener emitting update:modified on docChanged] }, parent: host.value!, revertControls: "b-to-a", gutter: true, collapseUnchanged: { margin: 3, minSize: 4 }, orientation: "a-b" })`.
- Store the `MergeView` in a `shallowRef`; `onBeforeUnmount` → `view.value?.destroy()`.
- The MergeView's own DOM needs a height: wrapper `class="h-80 overflow-auto rounded-md border border-border/60 bg-background/60"` and a `<style>` rule `.cm-mergeView { height: 100% }` (unscoped inside the component is acceptable only for `:deep(.cm-mergeView)` — use `:deep()` in a scoped style block).
- Watch `modified` → dispatch into `view.b` when different; watch `original` → rebuild (destroy + create); watch `editable` → reconfigure `readOnlyCompartment` on `view.b`.

- [ ] **Step 2: Verify**

Run: `bun run typecheck && bun run lint && cd apps/web && bun run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/review/SplitDiff.vue
git commit apps/web/src/components/review/SplitDiff.vue -m "feat(web): add split merge-view component"
```

---

### Task 7: `ReviewToolbar.vue`

**Files:**
- Create: `apps/web/src/components/review/ReviewToolbar.vue`

**Interfaces:**
- Consumes: shadcn-vue `Button` (`@/components/ui/button`), lucide icons (`@lucide/vue`).
- Produces: props `{ reviewed: boolean; canSave: boolean; canRevert: boolean; saving: boolean; dirty: boolean; revertHint?: string }`, emits `toggle-reviewed: []`, `save: []`, `revert: []`.

- [ ] **Step 1: Implement the component**

Template requirements (exact labels):

- Reviewed button: `variant="outline"` `size="sm"`, `:aria-pressed="reviewed"`, `:class="reviewed ? 'border-primary text-primary' : ''"`, label `Đã duyệt` (icon `Check`), `title="Chỉ đánh dấu trong phiên này — không ghi gì lên Runner."`; disabled when `!canSave && !reviewed`? No — reviewed is toggleable whenever a diff is shown; the parent passes `canReview` via `canSave`? Keep simple: always enabled; the parent only renders the toolbar when a diff is open.
- Save button: `variant="default"` `size="sm"`, icon `Save`, label `saving ? "Đang lưu…" : "Lưu"`, `:disabled="!canSave || saving"`, `title="Ghi nội dung đã duyệt qua file.write có kiểm tra revision."`.
- Revert button: `variant="outline"` `size="sm"` with destructive classes (same pair `InspectPanel.vue` uses), icon `RotateCcw`, label `Khôi phục`, `:disabled="!canRevert"`, `:title="revertHint ?? 'Khôi phục tệp về bản chụp lúc bắt đầu chạy.'"`.
- No Commit button, no `dirty`-only state — `dirty` is used to disable Save (`:disabled="!canSave || saving"`; the parent computes canSave as dirty && editable && !conflict). Remove `dirty` from props if it ends up unused; the plan's contract lists it, so use it in the Save title: `dirty ? "Lưu thay đổi đã duyệt." : "Không có thay đổi để lưu."`.

- [ ] **Step 2: Verify**

Run: `bun run typecheck && bun run lint && cd apps/web && bun run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/review/ReviewToolbar.vue
git commit apps/web/src/components/review/ReviewToolbar.vue -m "feat(web): add review toolbar with §16.4 action semantics"
```

---

### Task 8: Files tab — CodeMirror editor and conflict UI

**Files:**
- Modify: `apps/web/src/components/InspectPanel.vue`

**Interfaces:**
- Consumes: `CodeEditor.vue` (Task 4, via `defineAsyncComponent`), `resolveIncoming` (Task 3), existing `readFile`/`writeFile`.
- Produces: nothing downstream.

- [ ] **Step 1: Replace the textarea**

- Add `const CodeEditor = defineAsyncComponent(() => import("./review/CodeEditor.vue"));`
- Replace `<textarea v-model="draft" … />` with
  `<CodeEditor v-model="draft" :path="viewer.path" class="max-h-80" />`
  (keep the surrounding draft header and save button).
- Keep the read-only `<pre>` path for `draft === null`; no draft is created for binary/truncated files.

- [ ] **Step 2: Add conflict state**

- New refs: `conflictIncoming = ref<FileReadResult | null>(null)`, `conflictNote = ref<string | null>(null)`.
- `isDraftDirty()` helper: `viewer.value !== null && draft.value !== null && isDirty(viewer.value.content ?? "", draft.value)`.
- In `openEntry`, when the path equals the currently open viewer's path and `resolveIncoming({ currentHash: viewer.hash, incomingHash: outcome.hash, draftDirty: isDraftDirty() }) === "conflict"`: keep `viewer` + `draft`, set `conflictIncoming = outcome.value`, and return without replacing them. Otherwise behave as today.
- In `saveFile`, on `outcome.code === "FILE_CONFLICT"`: `const fresh = await readFile(id, viewer.path); if (fresh.ok) conflictIncoming = fresh.value;` and keep the draft.
- Banner (above the editor, replacing the old error line when a conflict exists):

  ```
  <p>Tệp đã bị thay đổi trên Runner kể từ khi mở. Bản nháp của bạn được giữ nguyên.</p>
  <Button size="sm" variant="outline" @click="adoptConflict">Tải bản mới (bỏ bản nháp)</Button>
  <Button size="sm" variant="destructive" @click="overwriteConflict">Ghi đè bằng bản nháp</Button>
  ```
  plus the existing save-error text when `saveError !== null`.

- `adoptConflict()`: set `viewer = conflictIncoming`, `draft = content` when text/untruncated (same predicate as `openEntry`), clear conflict refs, clear `saveError`.
- `overwriteConflict()`: `const latest = await readFile(id, viewer.path); if (!latest.ok) { saveError = latest.message; return; } const outcome = await writeFile(id, viewer.path, draft, latest.value.hash); if (outcome.ok) { viewer = viewerAfterSave(latest.value, draft, outcome); draft = outcome.content; conflict refs cleared; void loadFiles(directory); } else { saveError = outcome.message; }` — a second `FILE_CONFLICT` keeps the banner (refetch again in the same path as `saveFile`).
- Clear both conflict refs when the session/workspace changes (the existing watch), when a different file is opened, and when a save/adopt succeeds.

- [ ] **Step 3: Verify**

Run: `bun run typecheck && bun run lint && cd apps/web && bun run build`
Expected: clean. Also run `bun test` — the existing `features/inspect/*` tests must stay green.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/InspectPanel.vue
git commit apps/web/src/components/InspectPanel.vue -m "feat(web): edit files in CodeMirror with draft conflict handling"
```

---

### Task 9: Changes tab — merge view and review toolbar

**Files:**
- Modify: `apps/web/src/components/InspectPanel.vue`

**Interfaces:**
- Consumes: `parseUnifiedDiff` (Task 2), `resolveIncoming`/`defaultDiffMode`/`reviewKey`/`isReviewed` (Task 3), `UnifiedDiff.vue` (Task 5), `SplitDiff.vue` (Task 6), `ReviewToolbar.vue` (Task 7), existing `fetchDiff`/`readFile`/`writeFile`/`revertFile`/`fetchSnapshotStatus`.

- [ ] **Step 1: Extend the diff state**

New refs:
```ts
const diffParsed = ref<ParsedUnifiedDiff | null>(null);
const diffRead = ref<FileReadResult | null>(null);   // authoritative working side
const diffModified = ref<string>("");                 // merged document the reviewer settles on
const diffModeOverride = ref<"unified" | "split" | null>(null);
const diffWidth = ref(0);
const reviewed = ref<Set<string>>(new Set());
const reviewConfirmRevert = ref(false);
const reviewSnapshotEntry = ref<SnapshotEntry | null>(null);
```

`openDiff(path)` (keep its `epoch` guard):
1. `const [diffOutcome, readOutcome] = await Promise.all([fetchDiff(id, path), readFile(id, path)]);`
2. If `diffOutcome` failed → as today.
3. `diffParsed = diffOutcome.value.truncated ? null : parseUnifiedDiff(diffOutcome.value.diff);`
4. `diffRead = readOutcome.ok ? readOutcome.value : null;`
5. `diffModified = diffRead.content` when it is text and untruncated; otherwise the parsed `modified` (read-only).
6. `reviewed`/revert state resets: `reviewConfirmRevert = false`.
7. Lazily `fetchSnapshotStatus(id)` and store the entry for `path` in `reviewSnapshotEntry` (only when the snapshot source has a baseline); a failure leaves it `null` and Revert disabled.

`diffEditable = computed(() => diffRead.value !== null && !diffRead.value.binary && !diffRead.value.truncated && diffRead.value.content !== null)`. An empty file (`content === ""`) is editable — the predicate tests `content !== null`, never truthiness.

`diffDirty = computed(() => diffRead.value !== null && diffRead.value.content !== null && diffRead.value.content !== diffModified.value)`.

- [ ] **Step 2: Render the merge view**

In the git-source diff branch, when `diffParsed !== null`:
- Header gains the mode toggle: two buttons `Một cột` / `Hai cột`, active state `diffMode`, and the reviewed badge `đã duyệt` when `isReviewed(reviewed, diffPath, diffRead?.hash ?? "")`.
- Editor:
  ```vue
  <component
    :is="diffMode === 'split' ? SplitDiff : UnifiedDiff"
    :original="diffParsed.original"
    :modified="diffModified"
    :editable="diffEditable"
    :path="diffPath ?? undefined"
    @update:modified="diffModified = $event"
  />
  ```
  Both components are `defineAsyncComponent` imports.
- Below it: `<ReviewToolbar :reviewed="…" :can-save="diffEditable && diffDirty" :can-revert="reviewSnapshotEntry?.revertable === true" :saving="saving" :dirty="diffDirty" :revert-hint="…" @toggle-reviewed="toggleReviewed" @save="saveDiff" @revert="reviewConfirmRevert = true" />`
- When `diffParsed === null` (truncated/binary/multi-file/parse failure): keep today's `classifyDiffLines` `<pre>` rendering and add a notice: `Không dựng được chế độ so sánh cho tệp này — hiển thị diff dạng văn bản.`
- `diffMode = computed(() => diffModeOverride.value ?? defaultDiffMode(diffWidth.value))`. Measure with a `ResizeObserver` on the diff container; disconnect in `onBeforeUnmount`/`onUnmounted`.
- `reviewConfirmRevert` renders inline: `Khôi phục về bản chụp lúc bắt đầu chạy?` `[Xác nhận] [Huỷ]`.

- [ ] **Step 3: Actions**

- `toggleReviewed()`: if currently reviewed, `reviewed.delete(key)` else `reviewed.add(key)`, then reassign a new `Set` (Vue reactivity).
- `saveDiff()`: `await writeFile(id, diffPath, diffModified, diffRead.hash)`; on success, add the new key `reviewKey(path, outcome.hash)` to `reviewed`, then `void loadChanges(); void openDiff(path);` — when the diff no longer exists (the saved content matches HEAD), `openDiff` would 404 the diff; instead call `loadChanges()` and clear `diff`/`diffPath`/`diffParsed` when the refreshed change list no longer contains the path. On failure, surface `saveError`-style message in the diff area.
- Revert confirm: `await revertFile(id, path, reviewSnapshotEntry.currentHash)` (nested confirm in the template, same inline pattern as the snapshot list), then refresh `loadChanges()` + `openDiff(path)` and `loadSnapshot()`.
- Skip both actions when `workspace.value === null`, `diffPath.value === null` or the URL pieces are missing.

- [ ] **Step 4: Verify**

Run: `bun run typecheck && bun run lint && cd apps/web && bun run build && bun test`
Expected: clean; all existing tests pass. The build must show the CodeMirror pieces in separate chunks (they are only imported through `defineAsyncComponent`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/InspectPanel.vue
git commit apps/web/src/components/InspectPanel.vue -m "feat(web): review diffs in a merge view with toolbar actions"
```

---

### Task 10: Whole-slice gate and spec reconciliation

**Files:**
- Modify (only if the implementation deviated): `docs/superpowers/specs/2026-11-01-p3d-codemirror-review-ui-design.md`

- [ ] **Step 1: Run the full gate**

```bash
export PATH="$HOME/.ponta/bin:$PATH"
bun test
bun run typecheck
bun run lint
cd apps/web && bun run build
```

Expected: suite green (≥ 1879 tests + the new pure tests), typecheck clean, lint clean (the four generated shadcn paths remain untouched and skipped), build OK.

- [ ] **Step 2: Reconcile the spec**

If any deviation was made with a `Ruling:` in the ledger, update the spec's §5 section in the same style as the code, and commit the spec file alone.

- [ ] **Step 3: Commit only when the spec changed**

```bash
git add docs/superpowers/specs/2026-11-01-p3d-codemirror-review-ui-design.md
git commit docs/superpowers/specs/2026-11-01-p3d-codemirror-review-ui-design.md -m "docs: record P3-D implementation rulings"
```
