# Monaco Review & Editor Dialog Design

Status: Implemented — supersedes the P3-D CodeMirror review UI, updated 2026-11-03. Monaco is the review/file editor in the shipped code; see ARCHITECTURE §16.

## 1. Intent & Problem Statement

P3-D shipped an initial CodeMirror review & merge view embedded directly inside the secondary Inspect drawer (`InspectPanel.vue`).
In real-world usage, this embedded approach suffered from three major UX issues:
1. **Narrow sidebar constraint**: The Inspect drawer is only ~360–420px wide. Fitting a side-by-side or even unified merge diff into this small column forces awkward line wrapping and heavy horizontal scrolling.
2. **Obtrusive merge controls**: CodeMirror's `@codemirror/merge` injects `Accept` and `Reject` buttons inline directly onto code lines, frequently obscuring text and overlapping syntax tokens.
3. **Cramped action buttons & highlight styling**: The review actions ("Đã duyệt", "Lưu", "Khôi phục") sat directly below the horizontal scrollbar with poor spacing, and diff chunk contrast was hard to read.

The operator requested switching to **Monaco Editor (VS Code engine)** rendered inside a **Dialog with Fullscreen capability** for both **Diff review (Thay đổi)** and **File editing/viewing (Tệp tin)**.

## 2. Goals

- **Monaco Diff Editor in Modal**: Clicking any file in the "Thay đổi" (Changes) list opens a dedicated, spacious Dialog powered by Monaco Diff Editor (`monaco.editor.createDiffEditor`).
- **Fullscreen Capability**: The Dialog has a prominent Fullscreen toggle (`⛶ Toàn màn hình` / `Esc` to restore), allowing operators to view diffs at 100% viewport width and height.
- **Split & Inline Diff Modes**: Operators can easily switch between 2-column (side-by-side) and 1-column (inline) diff view using Monaco's native `renderSideBySide` setting.
- **Single File Viewing & Editing in Dialog**: In the "Tệp tin" (Files) tab, provide a "Mở rộng / Toàn màn hình" action that opens the file in Monaco Editor (`monaco.editor.create`), with full syntax highlighting, search/replace, and direct saving.
- **Clean Action Bar**: Move action controls (Đã duyệt / Reviewed, Lưu / Save, Khôi phục / Revert) to a dedicated, well-spaced dialog header/footer, completely eliminating inline buttons that obscure code.
- **Vite & Bun Compatibility**: Integrate `monaco-editor` cleanly in `apps/web` with Vite worker support without breaking existing build gates (`bun run build`, `bun test`, `bun run typecheck`, `bun run lint`).

## 3. Non-Goals

- CodeMirror: fully phased out, not kept as a fallback. No CodeMirror package remains in `apps/web/package.json` and no CodeMirror component remains in `apps/web/src`; Monaco handles all review and file viewing. This replaces the earlier open question in this document.
- No changes to backend RPC or Runner protocol: all operations continue to use existing `file.read`, `file.write`, `git.diff`, `git.changes`, `file.revert`, and `snapshot.status`.
- No full IDE workspace (ADR-010 stands: review-first surface).

## 4. Architecture & UX Specification

### 4.1 Dialog UI Structure (`ReviewDialog.vue` / `MonacoDiffModal.vue`)
- **Default State**: Centered modal, `w-[92vw] h-[88vh] max-w-7xl`, dark theme matching cc-web design tokens (`bg-background border-border`).
- **Fullscreen State**: Toggle expands to `fixed inset-0 w-screen h-screen z-50 rounded-none`, maximizing editor real estate.
- **Diff Mode Default**: Split (Hai cột) by default on wide screens (≥1024px), toggleable to Inline (Một cột).
- **Theming**: Monaco custom theme `cc-web-dark` registered via `monaco.editor.defineTheme` matching `#09090b` background and shadcn theme border/accent colors.
- **Header Bar**:
  - Left: File path icon + file name, status pill (`+x -y`, modified/added/deleted badge).
  - Center: Mode switch toggle: **Hai cột (Split)** vs **Một cột (Inline)**.
  - Right:
    - Minimap toggle (default on in split mode, hides when modal width < 900px).
    - Fullscreen toggle button (`Maximize2` / `Minimize2` icon with tooltip).
    - Close button (`✕` icon / keyboard shortcut `ESC`).
- **Body Area**:
  - `div.flex-1.relative` hosting the Monaco Diff Editor (or Monaco Single Editor).
  - Handles automatic resize via `automaticLayout: true` or `ResizeObserver`.
- **Files Tab Integration**:
  - In the "Tệp tin" tab, clicking "Mở rộng" / "Fullscreen" opens the single-file Monaco Editor in this modal with full edit and save capabilities (reusing dirty tracking and revision-checked `file.write`).
- **Reviewed Workflow**:
  - Clicking `✓ Đã duyệt (Reviewed)` marks the active file as reviewed.
  - If there are subsequent unreviewed changed files in the list, the modal immediately advances to the next file (like GitHub PR review).
  - When all files have been reviewed, shows a success toast ("Đã duyệt toàn bộ thay đổi.") and smoothly closes the modal.
  - Modal header includes navigation arrows `<` `>` and counter (e.g. `File 2/5`) for manual hopping between changed files.
- **Footer Bar**:
  - Left: Revision info / status indicator (e.g. "Chưa lưu thay đổi" if edited, or conflict notice).
  - Right:
    - `Khôi phục (Revert)`: triggers existing baseline revert confirmation dialog.
    - `Lưu (Save)`: enabled when modified content differs from server; writes via `file.write` with revision check.
    - `✓ Đã duyệt (Reviewed)`: toggles local reviewed state and advances to next file.

### 4.2 Monaco Setup in Vite
- Install `monaco-editor` in `apps/web`.
- Configure `MonacoEnvironment.getWorker` in a dedicated helper `apps/web/src/features/monaco/monaco-setup.ts` using Vite's `?worker` syntax for `editor.worker`, `json.worker`, `css.worker`, `html.worker`, `ts.worker`.
- Monaco is loaded lazily so initial web page load remains fast.

### 4.3 Preservation of Existing Logic
- Re-use `spliceOriginal` and diff parsing from `features/review/` if needed, or feed original (HEAD) and modified (working tree) directly to Monaco's `createModel`. Monaco Diff Editor natively computes and displays high-quality diffs when given original content and modified content.
- Keep dirty draft tracking and conflict resolution (`adopt`, `keep-draft`, `conflict`).

## 5. What's Left to the Builder

- Choosing exact component file names (e.g., `ReviewModal.vue` in `components/review/` or `ReviewDialog.vue`).
- CodeMirror deprecation: done. Packages and components removed; nothing left to retain or deprecate.
