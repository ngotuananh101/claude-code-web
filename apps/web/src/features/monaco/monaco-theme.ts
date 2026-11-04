import type * as monaco from "monaco-editor";
import type { ResolvedTheme } from "@/lib/theme.ts";

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
 * Light theme for cc-web with #ffffff background and clear diff colors.
 */
export const CC_WEB_LIGHT_THEME: monaco.editor.IStandaloneThemeData = {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    // Editor background matches cc-web light theme
    "editor.background": "#ffffff",

    // Borders
    "editorWidget.border": "#e4e4e7",
    "panel.border": "#e4e4e7",

    // Diff colors: readable green and red tints on white background
    "diffEditor.insertedTextBackground": "#16a34a26",
    "diffEditor.removedTextBackground": "#dc262624",

    // Line number gutter
    "editorLineNumber.foreground": "#a1a1aa",
    "editorLineNumber.activeForeground": "#3f3f46",

    // Selection
    "editor.selectionBackground": "#d4d4d880",
    "editor.inactiveSelectionBackground": "#e4e4e780",

    // Cursor
    "editorCursor.foreground": "#18181b",
  },
};

export function monacoThemeForResolvedTheme(
  resolved: ResolvedTheme,
): "cc-web-dark" | "cc-web-light" {
  return resolved === "dark" ? "cc-web-dark" : "cc-web-light";
}

/**
 * Registers the cc-web-dark and cc-web-light themes with a Monaco instance.
 */
export function defineCcWebThemes(monacoInstance: typeof monaco): void {
  monacoInstance.editor.defineTheme("cc-web-dark", CC_WEB_DARK_THEME);
  monacoInstance.editor.defineTheme("cc-web-light", CC_WEB_LIGHT_THEME);
}
