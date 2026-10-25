/**
 * Shared bounds for branch lists. The protocol parser
 * (`packages/protocol/src/reconcile.ts`) enforces the same numbers on the
 * wire; these mirror them for the runner's own listing so a well-behaved
 * runner never trips its own declaration's parse.
 */

/** Past this the composer dropdown is unusable anyway. */
const MAX_BRANCHES = 200;
/** Git refnames cap far below this; a longer line is junk, not a branch. */
const MAX_BRANCH_NAME = 256;

/**
 * Raw `for-each-ref` lines into a bounded, deduplicated list: empties and
 * over-length entries dropped, the first 200 kept, the first occurrence of
 * a duplicate kept.
 */
export function parseBranchLines(lines: readonly string[]): string[] {
  const branches: string[] = [];
  for (const line of lines) {
    const name = line.trim();
    if (name === "") continue;
    if (name.length > MAX_BRANCH_NAME) continue;
    if (branches.length >= MAX_BRANCHES) break;
    if (!branches.includes(name)) branches.push(name);
  }
  return branches;
}
