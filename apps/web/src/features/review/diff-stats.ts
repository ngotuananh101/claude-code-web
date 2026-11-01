/**
 * Line-change totals for the diff dialog's `+x −y` status pill.
 *
 * The counts come from Monaco's own diff (`getLineChanges`), so the pill
 * agrees with the hunks the operator sees rather than with a second,
 * independent line diff. Monaco reports an empty side as end line `0` — an
 * insertion at the very top even reports start `0`, so the empty check comes
 * first.
 */

export type LineChangeSummary = { added: number; removed: number };

export type MonacoLineChange = {
  readonly originalStartLineNumber: number;
  readonly originalEndLineNumber: number;
  readonly modifiedStartLineNumber: number;
  readonly modifiedEndLineNumber: number;
};

function countLines(start: number, end: number): number {
  if (end === 0) return 0;
  return end - start + 1;
}

export function summariseLineChanges(changes: readonly MonacoLineChange[]): LineChangeSummary {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    added += countLines(change.modifiedStartLineNumber, change.modifiedEndLineNumber);
    removed += countLines(change.originalStartLineNumber, change.originalEndLineNumber);
  }
  return { added, removed };
}
