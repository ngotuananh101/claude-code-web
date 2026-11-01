# Monaco Review & Editor Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cramped embedded sidebar diff and file editor with a dedicated, spacious Dialog powered by Monaco Editor (VS Code engine) featuring Fullscreen toggle, Split/Inline diff switching, auto-advancing file review, and clean styling.

**Architecture:**
Pure logic is isolated into testable modules (`monaco-languages.ts`, `review-navigation.ts`, `monaco-theme.ts`) tested with `bun test`.
Monaco components (`MonacoDiffEditor.vue`, `MonacoCodeEditor.vue`) wrap Monaco Editor instances with automatic layout and reactive prop bindings.
`ReviewDialog.vue` unifies the modal frame: header navigation, mode toggle, fullscreen switch, editor container, and footer action bar (Save, Revert, Reviewed with auto-advance). `InspectPanel.vue` wires file clicks in "Thay đổi" and the fullscreen action in "Tệp tin" to this modal.

**Tech Stack:** Vue 3 (SFC), TypeScript 7 / Vite 6, `monaco-editor` 0.57.0, shadcn-vue dialog primitives, Tailwind CSS v4.

**Spec:** `docs/superpowers/specs/2026-11-01-monaco-review-dialog-design.md`

## Global Constraints

- **Never edit generated shadcn-vue files**: `apps/web/src/components/ui/**`, `apps/web/src/lib/utils.ts`, `apps/web/src/styles/index.css`, `apps/web/components.json`.
- **Theme integration**: Use generated CSS variables (`var(--background)`, `var(--border)`, `var(--primary)`, `var(--muted-foreground)`) or Tailwind utilities; dark theme matches `#09090b`.
- **Typecheck gate**: `bun run typecheck` runs `tsc -b`, apps/web tsc, and `scripts/typecheck-vue.ts` via `vue-tsgo`. SFC templates must not double-unwrap refs or access missing properties.
- **Verification gates**: Every task must pass `bun test`, `bun run typecheck`, `bun run lint`, and `cd apps/web && bun run build`.

## Review Focus

1. **Empty or single-file changes list**: When `paths` has only 1 file or all files are reviewed, auto-advancing on "✓ Đã duyệt" must cleanly close the dialog and notify the user without index out-of-bounds error.
2. **Dirty draft preservation during navigation**: When moving between files or closing fullscreen, unsaved edits to the modified document must prompt or preserve state rather than silently discarding work.
3. **Large files and memory cleanup**: Monaco models and diff editor instances must be explicitly disposed (`dispose()`) on dialog unmount or file switch to prevent memory leaks.
4. **Window resize and fullscreen transitions**: Switching between standard dialog size and fullscreen must trigger `editor.layout()` so editor gutters and minimap instantly resize without graphical glitches.
5. **Non-git or binary files**: Files marked as binary or unreadable in `git.diff` must display a clean placeholder instead of crashing the Monaco text model.

---

### Task 1: Monaco Language Detection & Theme Mapping

**Files:**
- Create: `apps/web/src/features/monaco/monaco-languages.ts`
- Create: `apps/web/src/features/monaco/monaco-languages.test.ts`
- Create: `apps/web/src/features/monaco/monaco-theme.ts`
- Create: `apps/web/src/features/monaco/monaco-theme.test.ts`

**Interfaces:**
- Produces:
  - `monacoLanguageForPath(path: string): string`: returns Monaco language id (e.g. `typescript`, `markdown`, `json`, `plaintext`).
  - `CC_WEB_DARK_THEME`: Monaco `IStandaloneThemeData` with `#09090b` background, dark border, and clear diff chunk colors.
  - `defineCcWebThemes(monacoInstance: typeof monaco): void`: registers `cc-web-dark` theme.

- [ ] **Step 1: Write the failing tests for language detection and theme**

```typescript
// apps/web/src/features/monaco/monaco-languages.test.ts
import { describe, expect, test } from "bun:test";
import { monacoLanguageForPath } from "./monaco-languages.ts";

describe("monacoLanguageForPath", () => {
  test("maps typescript and javascript extensions", () => {
    expect(monacoLanguageForPath("src/index.ts")).toBe("typescript");
    expect(monacoLanguageForPath("src/App.vue")).toBe("html");
    expect(monacoLanguageForPath("src/main.js")).toBe("javascript");
    expect(monacoLanguageForPath("types.d.ts")).toBe("typescript");
  });

  test("maps common formats", () => {
    expect(monacoLanguageForPath("README.md")).toBe("markdown");
    expect(monacoLanguageForPath("package.json")).toBe("json");
    expect(monacoLanguageForPath("script.py")).toBe("python");
    expect(monacoLanguageForPath("style.css")).toBe("css");
    expect(monacoLanguageForPath("config.yaml")).toBe("yaml");
    expect(monacoLanguageForPath("deploy.sh")).toBe("shell");
  });

  test("falls back to plaintext for unknown extensions or extensionless files", () => {
    expect(monacoLanguageForPath("LICENSE")).toBe("plaintext");
    expect(monacoLanguageForPath("data.xyz123")).toBe("plaintext");
  });
});
```

```typescript
// apps/web/src/features/monaco/monaco-theme.test.ts
import { describe, expect, test } from "bun:test";
import { CC_WEB_DARK_THEME } from "./monaco-theme.ts";

describe("CC_WEB_DARK_THEME", () => {
  test("defines dark base and matching background", () => {
    expect(CC_WEB_DARK_THEME.base).toBe("vs-dark");
    expect(CC_WEB_DARK_THEME.colors["editor.background"]).toBe("#09090b");
  });

  test("defines readable diff colors without intrusive buttons", () => {
    expect(CC_WEB_DARK_THEME.colors["diffEditor.insertedTextBackground"]).toBeDefined();
    expect(CC_WEB_DARK_THEME.colors["diffEditor.removedTextBackground"]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/features/monaco/monaco-languages.test.ts apps/web/src/features/monaco/monaco-theme.test.ts`
Expected: FAIL (files do not exist).

- [ ] **Step 3: Implement `monaco-languages.ts` and `monaco-theme.ts`**

Write `monaco-languages.ts` with extension mapping and `monaco-theme.ts` with `CC_WEB_DARK_THEME` object.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/features/monaco/monaco-languages.test.ts apps/web/src/features/monaco/monaco-theme.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/monaco/monaco-languages.* apps/web/src/features/monaco/monaco-theme.*
git commit -m "feat(web): add Monaco language mapping and cc-web-dark theme"
```

---

### Task 2: Review Navigation & Auto-Advance Logic

**Files:**
- Create: `apps/web/src/features/review/review-navigation.ts`
- Create: `apps/web/src/features/review/review-navigation.test.ts`

**Interfaces:**
- Produces:
  - `findNextUnreviewedPath(paths: string[], currentPath: string, isReviewed: (path: string) => boolean): string | null`: returns the next unreviewed path in cyclic order, or `null` if all are reviewed.
  - `findPrevPath(paths: string[], currentPath: string): string | null`: returns previous path in list or wrap around.
  - `findNextPath(paths: string[], currentPath: string): string | null`: returns next path in list or wrap around.
  - `formatFileCounter(paths: string[], currentPath: string): string`: returns e.g. `"2 / 5"`.

- [ ] **Step 1: Write the failing tests for review navigation**

```typescript
// apps/web/src/features/review/review-navigation.test.ts
import { describe, expect, test } from "bun:test";
import {
  findNextPath,
  findNextUnreviewedPath,
  findPrevPath,
  formatFileCounter,
} from "./review-navigation.ts";

describe("review-navigation", () => {
  const paths = ["fileA.ts", "fileB.ts", "fileC.ts"];

  test("findNextUnreviewedPath advances to next unreviewed file", () => {
    const reviewed = new Set(["fileA.ts"]);
    const isRev = (p: string) => reviewed.has(p);

    expect(findNextUnreviewedPath(paths, "fileA.ts", isRev)).toBe("fileB.ts");
  });

  test("findNextUnreviewedPath skips reviewed files and wraps around", () => {
    const reviewed = new Set(["fileB.ts"]);
    const isRev = (p: string) => reviewed.has(p);

    // Current is fileB, next unreviewed should be fileC
    expect(findNextUnreviewedPath(paths, "fileB.ts", isRev)).toBe("fileC.ts");

    // Current is fileC, next unreviewed should wrap to fileA
    expect(findNextUnreviewedPath(paths, "fileC.ts", isRev)).toBe("fileA.ts");
  });

  test("findNextUnreviewedPath returns null when all files are reviewed", () => {
    const reviewed = new Set(["fileA.ts", "fileB.ts", "fileC.ts"]);
    const isRev = (p: string) => reviewed.has(p);

    expect(findNextUnreviewedPath(paths, "fileB.ts", isRev)).toBeNull();
  });

  test("findPrevPath and findNextPath navigate circularly", () => {
    expect(findPrevPath(paths, "fileA.ts")).toBe("fileC.ts");
    expect(findPrevPath(paths, "fileB.ts")).toBe("fileA.ts");
    expect(findNextPath(paths, "fileC.ts")).toBe("fileA.ts");
    expect(findNextPath(paths, "fileA.ts")).toBe("fileB.ts");
  });

  test("formatFileCounter formats 1-based index and total count", () => {
    expect(formatFileCounter(paths, "fileA.ts")).toBe("1 / 3");
    expect(formatFileCounter(paths, "fileB.ts")).toBe("2 / 3");
    expect(formatFileCounter(paths, "unknown.ts")).toBe("0 / 3");
    expect(formatFileCounter([], "fileA.ts")).toBe("0 / 0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/features/review/review-navigation.test.ts`
Expected: FAIL (file does not exist).

- [ ] **Step 3: Implement `review-navigation.ts`**

Write `review-navigation.ts` with cyclic lookup and counter helpers.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/features/review/review-navigation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/review/review-navigation.*
git commit -m "feat(web): add review navigation and auto-advance logic"
```

---

### Task 3: Monaco Vite Worker Setup & Editor Components

**Files:**
- Create: `apps/web/src/features/monaco/monaco-setup.ts`
- Create: `apps/web/src/components/review/MonacoDiffEditor.vue`
- Create: `apps/web/src/components/review/MonacoCodeEditor.vue`

**Interfaces:**
- Consumes:
  - `monaco-languages.ts`: `monacoLanguageForPath`
  - `monaco-theme.ts`: `defineCcWebThemes`, `CC_WEB_DARK_THEME`
- Produces:
  - `initMonaco()`: singleton helper configuring `MonacoEnvironment` workers and registering themes.
  - `<MonacoDiffEditor :original :modified :path :render-side-by-side @update:modified />`
  - `<MonacoCodeEditor :content :path :read-only @update:content />`

- [ ] **Step 1: Create `monaco-setup.ts` with Vite worker loaders and theme registration**

```typescript
// apps/web/src/features/monaco/monaco-setup.ts
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { defineCcWebThemes } from "./monaco-theme.ts";

let initialized = false;

export function initMonaco(): typeof monaco {
  if (typeof window !== "undefined" && !initialized) {
    self.MonacoEnvironment = {
      getWorker(_: unknown, label: string) {
        if (label === "json") return new jsonWorker();
        if (label === "css" || label === "scss" || label === "less") return new cssWorker();
        if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
        if (label === "typescript" || label === "javascript") return new tsWorker();
        return new editorWorker();
      },
    };
    defineCcWebThemes(monaco);
    initialized = true;
  }
  return monaco;
}
```

- [ ] **Step 2: Create `MonacoDiffEditor.vue`**

Component setup:
- Props: `original: string`, `modified: string`, `path?: string`, `renderSideBySide?: boolean`.
- Emits: `update:modified: [value: string]`.
- Lifecycle:
  - Mount: `initMonaco()`, `monaco.editor.createDiffEditor(container, { theme: 'cc-web-dark', automaticLayout: true, renderSideBySide: props.renderSideBySide ?? true })`.
  - Create models via `monaco.editor.createModel(original, lang)` and `monaco.editor.createModel(modified, lang)`.
  - Listen to `modifiedModel.onDidChangeContent` -> emit `update:modified`.
  - Watch `renderSideBySide` -> `diffEditor.updateOptions({ renderSideBySide })`.
  - Unmount: dispose models and editor instance cleanly.

- [ ] **Step 3: Create `MonacoCodeEditor.vue`**

Component setup:
- Props: `content: string`, `path?: string`, `readOnly?: boolean`.
- Emits: `update:content: [value: string]`.
- Mount: `monaco.editor.create(container, { value: props.content, language: lang, theme: 'cc-web-dark', automaticLayout: true, readOnly: props.readOnly ?? false })`.
- Listen to content change -> emit `update:content`.
- Unmount: dispose model and editor.

- [ ] **Step 4: Verify typecheck and build**

Run: `bun run typecheck && cd apps/web && bun run build`
Expected: PASS with 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/monaco/ apps/web/src/components/review/Monaco*
git commit -m "feat(web): add Monaco worker setup, DiffEditor, and CodeEditor components"
```

---

### Task 4: Review Dialog with Fullscreen & Auto-Advance

**Files:**
- Create: `apps/web/src/components/review/ReviewDialog.vue`

**Interfaces:**
- Consumes:
  - `review-navigation.ts`: `findNextUnreviewedPath`, `findPrevPath`, `findNextPath`, `formatFileCounter`
  - `MonacoDiffEditor.vue`, `MonacoCodeEditor.vue`
  - `@/components/ui/dialog`: `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`
- Props:
  - `open: boolean`
  - `mode: "diff" | "file"`
  - `path: string`
  - `allPaths: string[]`
  - `original: string` (diff mode)
  - `modified: string` (diff mode)
  - `content: string` (file mode)
  - `isReviewed: boolean`
  - `dirty: boolean`
- Emits:
  - `update:open: [value: boolean]`
  - `update:modified: [value: string]`
  - `update:content: [value: string]`
  - `selectPath: [path: string]`
  - `save: []`
  - `revert: []`
  - `toggleReviewed: []`

- [ ] **Step 1: Implement `ReviewDialog.vue`**

Features:
- `isFullscreen` ref: when true, applies `fixed inset-0 z-50 w-screen h-screen rounded-none max-w-none` to container.
- `renderSideBySide` ref (default `true` on screen width >= 1024px).
- Header:
  - Left: File name + extension, path breadcrumb.
  - Center: Prev/Next buttons (`< >`), file counter (`formatFileCounter`).
  - Right:
    - Diff mode toggle: Split vs Inline buttons (when `mode === 'diff'`).
    - Fullscreen toggle button (`Maximize2` / `Minimize2` from lucide-vue).
    - Close button (`X` from lucide-vue).
- Body:
  - If `mode === 'diff'`: renders `<MonacoDiffEditor :original :modified :path :render-side-by-side />`.
  - If `mode === 'file'`: renders `<MonacoCodeEditor :content :path @update:content />`.
- Footer:
  - Left: Save/dirty status (`Chưa lưu thay đổi`).
  - Right:
    - Button "Khôi phục" (Revert).
    - Button "Lưu" (Save - disabled if not dirty).
    - Button "✓ Đã duyệt" (toggles reviewed, calls `findNextUnreviewedPath`; if next exists -> emits `selectPath(next)`, otherwise shows toast and closes).

- [ ] **Step 2: Verify typecheck & build**

Run: `bun run typecheck && cd apps/web && bun run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/review/ReviewDialog.vue
git commit -m "feat(web): add ReviewDialog with fullscreen, split/inline diff, and auto-advance"
```

---

### Task 5: Integration into `InspectPanel.vue` & Verification

**Files:**
- Modify: `apps/web/src/components/InspectPanel.vue`

**Interfaces:**
- Wire clicking any file in `source === 'git'` or `source === 'snapshot'` list to open `ReviewDialog` in `diff` mode.
- Add an "Mở toàn màn hình / Mở Dialog" icon button to the Files tab toolbar that opens `ReviewDialog` in `file` mode.
- Update `openDiff(path)` to set `reviewDialogOpen = true`, `activeDiffPath = path`.

- [ ] **Step 1: Update `InspectPanel.vue` to integrate `ReviewDialog`**

- Import `ReviewDialog` lazily or directly.
- Add refs: `reviewModalOpen = ref(false)`, `reviewModalMode = ref<"diff" | "file">("diff")`.
- In `openDiff(path)`: open the modal instead of confining to sidebar.
- In Files tab toolbar: add button with `Maximize2` icon to pop out current open file into `ReviewDialog`.
- Provide list of changed paths (`changes?.map(c => c.path) ?? []`) to `ReviewDialog`.
- Implement `onReviewedAdvance(nextPath)`: marks reviewed for current path, then loads and opens next diff.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: clean (including `vue-tsgo`).

- [ ] **Step 3: Run biome lint**

Run: `bun run lint`
Expected: clean.

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: 1910+ pass, 0 fail.

- [ ] **Step 5: Run web build**

Run: `cd apps/web && bun run build`
Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/InspectPanel.vue
git commit -m "feat(web): integrate Monaco ReviewDialog into InspectPanel for diff and files"
```

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-11-01-monaco-review-dialog.md`.
