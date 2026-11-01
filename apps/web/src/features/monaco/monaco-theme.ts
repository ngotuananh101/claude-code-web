import type * as monaco from "monaco-editor";

/**
 * Dark theme for cc-web with #09090b background and clear diff colors.
 */
export const CC_WEB_DARK_THEME: monaco.editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    // Editor background matches cc-web dark theme
    "editor.background": "#09090b",

    // Borders
    "editorWidget.border": "#27272a",
    "panel.border": "#27272a",

    // Diff colors: subtle green and red with transparency
    "diffEditor.insertedTextBackground": "#16a34a33",
    "diffEditor.removedTextBackground": "#dc262633",

    // Line number gutter
    "editorLineNumber.foreground": "#52525b",
    "editorLineNumber.activeForeground": "#a1a1aa",

    // Selection
    "editor.selectionBackground": "#3f3f4680",
    "editor.inactiveSelectionBackground": "#3f3f4640",

    // Cursor
    "editorCursor.foreground": "#fafafa",
  },
};

/**
 * Registers the cc-web-dark theme with a Monaco instance.
 */
export function defineCcWebThemes(monacoInstance: typeof monaco): void {
  monacoInstance.editor.defineTheme("cc-web-dark", CC_WEB_DARK_THEME);
}
