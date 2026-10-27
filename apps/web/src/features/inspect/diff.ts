/**
 * Diff line classification for the Changes panel (P3-A ruling 12).
 *
 * The runner returns unified diff text; the panel only needs to know how to
 * tint each line. No merge view, no accept/reject — §16.4 keeps those out until
 * there is an editor whose state they could change.
 */

export type DiffLineKind = "add" | "remove" | "context" | "meta";

export type DiffLine = { kind: DiffLineKind; text: string };

/** Header and marker lines whose leading characters overlap the content ones. */
function isMeta(line: string): boolean {
  return (
    line.startsWith("@@") ||
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    // `+++`/`---` are file headers, but they start with the same characters as
    // added and removed content — the header rules must win.
    line.startsWith("+++") ||
    line.startsWith("---") ||
    // `\ No newline at end of file` is a note about the file, not a change.
    line.startsWith("\\")
  );
}

export function classifyDiffLines(diff: string): DiffLine[] {
  if (diff === "") return [];

  const lines = diff.split("\n");
  // A unified diff ends with a newline; the trailing empty element is not a
  // rendered line.
  if (lines[lines.length - 1] === "") lines.pop();

  return lines.map((text) => {
    if (isMeta(text)) return { kind: "meta", text };
    if (text.startsWith("+")) return { kind: "add", text };
    if (text.startsWith("-")) return { kind: "remove", text };
    return { kind: "context", text };
  });
}
