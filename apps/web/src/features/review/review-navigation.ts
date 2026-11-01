/**
 * Review navigation utilities for cycling through file paths.
 */

/**
 * Finds the next unreviewed path in cyclic order.
 * @param paths - Array of file paths
 * @param currentPath - Current active path
 * @param isReviewed - Function to check if a path is reviewed
 * @returns Next unreviewed path, or null if all are reviewed
 */
export function findNextUnreviewedPath(
  paths: string[],
  currentPath: string,
  isReviewed: (path: string) => boolean,
): string | null {
  if (paths.length === 0) {
    return null;
  }

  const currentIndex = paths.indexOf(currentPath);
  if (currentIndex === -1) {
    return null;
  }

  // Search forward from current position (wrapping around)
  for (let i = 1; i <= paths.length; i++) {
    const nextIndex = (currentIndex + i) % paths.length;
    const nextPath = paths[nextIndex];
    if (nextPath && !isReviewed(nextPath)) {
      return nextPath;
    }
  }

  // All files are reviewed
  return null;
}

/**
 * Decides where the dialog goes after the "Đã duyệt" toggle.
 *
 * Marking a file reviewed advances to the next unreviewed file, treating the
 * current file as reviewed (the parent flips it in the same event). Unmarking
 * a reviewed file never advances: the operator must see the mark disappear.
 *
 * @returns Next path to select, or null when the dialog should stay put
 *          (unmarking) or close (every file is reviewed).
 */
export function nextPathAfterToggleReview(input: {
  paths: string[];
  currentPath: string;
  alreadyReviewed: boolean;
  isPathReviewed: (path: string) => boolean;
}): string | null {
  if (input.alreadyReviewed) {
    return null;
  }
  return findNextUnreviewedPath(
    input.paths,
    input.currentPath,
    (path) => path === input.currentPath || input.isPathReviewed(path),
  );
}

/**
 * Finds the previous path in the list (wraps around).
 * @param paths - Array of file paths
 * @param currentPath - Current active path
 * @returns Previous path, or null if current path not found
 */
export function findPrevPath(paths: string[], currentPath: string): string | null {
  if (paths.length === 0) {
    return null;
  }

  const currentIndex = paths.indexOf(currentPath);
  if (currentIndex === -1) {
    return null;
  }

  const prevIndex = (currentIndex - 1 + paths.length) % paths.length;
  return paths[prevIndex] ?? null;
}

/**
 * Finds the next path in the list (wraps around).
 * @param paths - Array of file paths
 * @param currentPath - Current active path
 * @returns Next path, or null if current path not found
 */
export function findNextPath(paths: string[], currentPath: string): string | null {
  if (paths.length === 0) {
    return null;
  }

  const currentIndex = paths.indexOf(currentPath);
  if (currentIndex === -1) {
    return null;
  }

  const nextIndex = (currentIndex + 1) % paths.length;
  return paths[nextIndex] ?? null;
}

/**
 * Formats the file counter as "current / total" (1-based).
 * @param paths - Array of file paths
 * @param currentPath - Current active path
 * @returns Formatted counter string, e.g., "2 / 5"
 */
export function formatFileCounter(paths: string[], currentPath: string): string {
  const currentIndex = paths.indexOf(currentPath);
  const position = currentIndex === -1 ? 0 : currentIndex + 1;
  return `${position} / ${paths.length}`;
}

/**
 * The diff dialog's file list must agree with the Changes tab the operator is
 * looking at. A list that has not loaded yields no paths rather than borrowing
 * the hidden tab's set, which would let prev/next jump to files the visible
 * list does not contain.
 */
export function pathsForSource(input: {
  source: "git" | "snapshot";
  gitPaths: readonly string[];
  snapshotPaths: readonly string[];
}): string[] {
  return input.source === "git" ? [...input.gitPaths] : [...input.snapshotPaths];
}

export type DiffOpenIntent = "navigate" | "refresh";

/**
 * Whether the diff dialog should be open after a selection or a refresh.
 *
 * A row click (`navigate`) opens a usable diff, or closes the dialog when the
 * diff cannot be shown. A refresh (`refresh`) is what a save or revert runs:
 * the dialog just stays as the operator left it, because they may have closed
 * it while the write was in flight — reopening would yank them back. An
 * unusable diff closes in both cases so stale content is never stranded.
 *
 * @returns true to open, false to close, null to leave the state unchanged.
 */
export function reviewDialogVisibility(
  intent: DiffOpenIntent,
  diffIsUsable: boolean,
): boolean | null {
  if (!diffIsUsable) return false;
  return intent === "navigate" ? true : null;
}
