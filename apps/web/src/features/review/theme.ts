import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/**
 * CodeMirror theme for the review surface. Every color is a CSS variable
 * (var(--background), var(--foreground), var(--primary), var(--muted-foreground))
 * sourced from the shadcn-vue theme, so dark/light mode is handled by the
 * `.dark` class on documentElement and this module needs no JS scheme handling.
 */
const reviewTheme: Extension = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--background)",
      color: "var(--foreground)",
      fontSize: "12px",
    },
    ".cm-content": {
      fontFamily: "var(--font-mono, ui-monospace, monospace)",
      caretColor: "var(--primary)",
    },
    ".cm-cursor": {
      borderLeftColor: "var(--primary)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--background)",
      color: "var(--muted-foreground)",
      border: "none",
    },
    ".cm-activeLine": {
      backgroundColor: "color-mix(in srgb, var(--foreground) 6%, transparent)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "color-mix(in srgb, var(--primary) 20%, transparent)",
    },
    ".cm-token-keyword": {
      color: "var(--primary)",
      fontWeight: "600",
    },
    ".cm-token-string": {
      color: "var(--foreground)",
    },
    ".cm-token-comment": {
      color: "var(--muted-foreground)",
      fontStyle: "italic",
    },
    ".cm-token-number": {
      color: "var(--primary)",
    },
    ".cm-token-function": {
      color: "var(--foreground)",
    },
  },
  { dark: false },
);

const reviewHighlighting: Extension = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword, class: "cm-token-keyword" },
    { tag: [tags.string, tags.special(tags.string)], class: "cm-token-string" },
    {
      tag: [tags.lineComment, tags.blockComment, tags.docComment],
      class: "cm-token-comment",
    },
    { tag: [tags.number, tags.bool, tags.null], class: "cm-token-number" },
    {
      tag: [tags.function(tags.variableName), tags.definition(tags.function(tags.variableName))],
      class: "cm-token-function",
    },
  ]),
);

const reviewBaseExtensions: Extension[] = [reviewTheme, reviewHighlighting];

export { reviewBaseExtensions, reviewHighlighting, reviewTheme };
