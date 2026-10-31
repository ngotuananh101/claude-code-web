/** Unified-diff → document parser.
 *
 * Parses a single-file `git diff -- <path>` (text mode) and reconstructs the
 * original and modified full documents. Returns `null` when the input is not
 * exactly one complete single-file text diff.
 *
 * No CodeMirror runtime imports: this module is pure and safe under `bun test`
 * without a DOM.
 */

export type ParsedHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Context and deleted lines, in document order. */
  oldLines: string[];
  /** Context and added lines, in document order. */
  newLines: string[];
};

export type ParsedUnifiedDiff = {
  /** The hunk content of the original side — a fragment for partial-context diffs. */
  original: string;
  /** The hunk content of the modified side — a fragment for partial-context diffs. */
  modified: string;
  hunks: ParsedHunk[];
  /** The original side's last line lacks a trailing newline. */
  originalNoNewline: boolean;
};

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
  const hunks: ParsedHunk[] = [];
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

    const oldStart = Number(m[1]);
    const oldTotal = parseCount(m[2]);
    const newStart = Number(m[3]);
    const newTotal = parseCount(m[4]);
    let oldCount = oldTotal;
    let newCount = newTotal;
    const hunkOld: string[] = [];
    const hunkNew: string[] = [];
    i++;

    while (i < lines.length) {
      const body = lines[i]!;
      // A new hunk header or the start of another file header ends this hunk's
      // body. ("diff --git" is the only leading-header we accept as a hard
      // stop inside a single-file diff; we already rejected multi-file diffs
      // above, so seeing one here is stray → handled by the post-loop check.)
      if (HUNK_RE.test(body) || body.startsWith("diff --git ")) break;
      if (body === "") return null; // a blank line is not a valid body line

      const prefix = body[0]!;
      const content = body.slice(1);

      // Once both counters are exhausted, no further content line may appear
      // (that would be over-delivery → null per §5.2). The only valid line
      // after exhaustion is the "\ No newline" marker, which does not consume a
      // counter.
      const exhausted = oldCount <= 0 && newCount <= 0;
      if (exhausted && prefix !== "\\") {
        return null; // over-delivery past the claimed counts
      }

      if (prefix === " ") {
        original.push(content);
        modified.push(content);
        hunkOld.push(content);
        hunkNew.push(content);
        oldCount--;
        newCount--;
        lastPushedSide = "both";
      } else if (prefix === "-") {
        original.push(content);
        hunkOld.push(content);
        oldCount--;
        lastPushedSide = "original";
      } else if (prefix === "+") {
        modified.push(content);
        hunkNew.push(content);
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
    // the diff is incomplete → null.
    if (oldCount > 0 || newCount > 0) return null;

    hunks.push({
      oldStart,
      oldCount: oldTotal,
      newStart,
      newCount: newTotal,
      oldLines: hunkOld,
      newLines: hunkNew,
    });
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
    hunks,
    originalNoNewline,
  };
}

/**
 * Rebuild the full original document from the authoritative read of the file
 * under review and a parsed diff.
 *
 * A default-context `git diff` carries only its hunks, so the parser's own
 * `original` is a fragment. The read document is the full modified side; each
 * hunk's new-side range is checked against it and swapped for the hunk's
 * old-side lines. Returns `null` when the diff no longer matches the read
 * document (stale diff, a race between the two RPCs, or differing line
 * endings) so callers can fall back to the plain-text diff instead of showing
 * a merge view over mismatched text.
 */
export function spliceOriginal(parsed: ParsedUnifiedDiff, modified: string): string | null {
  if (parsed.hunks.length === 0) return null;

  const endsWithNewline = modified.endsWith("\n");
  const body = endsWithNewline ? modified.slice(0, -1) : modified;
  const modLines = modified === "" ? [] : body.split("\n");

  const out: string[] = [];
  let cursor = 0;
  for (const hunk of parsed.hunks) {
    // An empty new-side range (a pure deletion) sits *after* `newStart` lines;
    // a non-empty one starts at line `newStart` (1-based).
    const start = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    if (start < cursor || start + hunk.newCount > modLines.length) return null;
    for (let k = 0; k < hunk.newCount; k++) {
      if (modLines[start + k] !== hunk.newLines[k]) return null;
    }
    out.push(...modLines.slice(cursor, start), ...hunk.oldLines);
    cursor = start + hunk.newCount;
  }
  out.push(...modLines.slice(cursor));

  if (out.length === 0) return "";

  // The original's trailing newline follows the diff's end-of-file marker when
  // the last hunk reaches the end; otherwise the ending is unchanged from the
  // read document.
  const last = parsed.hunks[parsed.hunks.length - 1]!;
  const lastStart = last.newCount === 0 ? last.newStart : last.newStart - 1;
  const touchesEof = lastStart + last.newCount === modLines.length;
  const endsOriginal = parsed.originalNoNewline ? false : touchesEof ? true : endsWithNewline;
  const joined = out.join("\n");
  return endsOriginal ? `${joined}\n` : joined;
}
