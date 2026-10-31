/** Unified-diff → document parser.
 *
 * Parses a single-file `git diff -- <path>` (text mode) and reconstructs the
 * original and modified full documents. Returns `null` when the input is not
 * exactly one complete single-file text diff.
 *
 * No CodeMirror runtime imports: this module is pure and safe under `bun test`
 * without a DOM.
 */

export type ParsedUnifiedDiff = { original: string; modified: string };

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseCount(raw: string | undefined): number {
  // A missing count in a hunk header means 1 (git unified-diff convention).
  return raw === undefined ? 1 : Number(raw);
}

export function parseUnifiedDiff(diff: string): ParsedUnifiedDiff | null {
  if (diff.length === 0) return null;

  // Step 1: split on "\n"; drop a single trailing empty element (diff output
  // ends with "\n").
  const lines = diff.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  // Step 2: reject binary content immediately.
  for (const line of lines) {
    if (line.includes("Binary files") || line.startsWith("GIT binary patch")) {
      return null;
    }
  }

  // More than one "diff --git " header means more than one file → null.
  let diffGitCount = 0;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      diffGitCount++;
      if (diffGitCount > 1) return null;
    }
  }

  // Step 3: ignore leading header lines until the first hunk. Track whether a
  // file header ("diff --git", "---", "+++", "index", "new file mode", etc.)
  // was seen before it. A hunk before any file header → null.
  let i = 0;
  let sawFileHeader = false;
  while (i < lines.length && !HUNK_RE.test(lines[i]!)) {
    if (
      lines[i]!.startsWith("diff --git ") ||
      lines[i]!.startsWith("--- ") ||
      lines[i]!.startsWith("+++ ") ||
      lines[i]!.startsWith("index ") ||
      lines[i]!.startsWith("new file mode") ||
      lines[i]!.startsWith("deleted file mode")
    ) {
      sawFileHeader = true;
    }
    i++;
  }

  if (i >= lines.length) {
    // No hunk found. Headers without hunks → null (step 6); bare text without
    // a hunk header → null.
    return null;
  }

  if (!sawFileHeader) {
    // A hunk appeared before any file header.
    return null;
  }

  const original: string[] = [];
  const modified: string[] = [];
  let originalNoNewline = false;
  let modifiedNoNewline = false;
  // Tracks which side the last content-bearing line ("-"/""/"+") was pushed to,
  // so the "\ No newline" marker can adjust the correct side. A context line
  // (" ") counts as both sides.
  let lastPushedSide: "original" | "modified" | "both" = "both";

  // Step 4: walk each hunk, consuming its body up to the next hunk header, a new
  // file header, or end of input. The leading count in a hunk header is treated
  // as a claim on how many lines follow; if the body stops early (fewer lines
  // than claimed for a side) → null.
  while (i < lines.length) {
    const m = HUNK_RE.exec(lines[i]!);
    if (!m) break; // not a hunk header → done (stray lines rejected below)

    let oldCount = parseCount(m[2]);
    let newCount = parseCount(m[4]);
    i++;

    while (i < lines.length) {
      const body = lines[i]!;
      // The next hunk header or the start of another file header ends this
      // hunk's body. ("diff --git" is the only leading-header we accept as a
      // hard stop inside a single-file diff; we already rejected multi-file
      // diffs above, so seeing one here is stray → handled by the post-loop
      // check.)
      if (HUNK_RE.test(body) || body.startsWith("diff --git ")) break;
      if (body === "") return null; // a blank line is not a valid body line

      const prefix = body[0]!;
      const content = body.slice(1);

      if (prefix === " ") {
        original.push(content);
        modified.push(content);
        oldCount--;
        newCount--;
        lastPushedSide = "both";
      } else if (prefix === "-") {
        original.push(content);
        oldCount--;
        lastPushedSide = "original";
      } else if (prefix === "+") {
        modified.push(content);
        newCount--;
        lastPushedSide = "modified";
      } else if (prefix === "\\") {
        // "\ No newline at end of file": adjust only the side whose last
        // content line was just pushed.
        if (body === "\\ No newline at end of file") {
          if (lastPushedSide === "original") {
            originalNoNewline = true;
          } else if (lastPushedSide === "modified") {
            modifiedNoNewline = true;
          } else {
            // Followed a context line → both sides lack a trailing newline.
            originalNoNewline = true;
            modifiedNoNewline = true;
          }
        } else {
          return null;
        }
      } else {
        // Anything else → null.
        return null;
      }
      i++;
    }

    // If the body stopped early — a side claimed more lines than delivered —
    // the diff is incomplete → null. (Counts may run negative when a hunk
    // header under-counts its context body; that is tolerated.)
    if (oldCount > 0 || newCount > 0) return null;
  }

  // Reject stray leftover lines (e.g. a second file header / hunk header that
  // is not part of this single-file diff).
  if (i < lines.length) return null;

  // Step 5: join, then append "\n" to each side that has lines and whose last
  // line is not marked no-newline. A side with no lines is "".
  const joinSide = (acc: string[], noNewline: boolean): string => {
    if (acc.length === 0) return "";
    const joined = acc.join("\n");
    if (noNewline) return joined;
    return `${joined}\n`;
  };

  return {
    original: joinSide(original, originalNoNewline),
    modified: joinSide(modified, modifiedNoNewline),
  };
}
