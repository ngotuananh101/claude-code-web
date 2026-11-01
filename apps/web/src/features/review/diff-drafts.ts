/**
 * Unsaved-draft preservation across file navigation in the review dialog.
 *
 * Navigating away from a dirty diff must not silently discard the operator's
 * edits: the draft is remembered per path and restored when the path is opened
 * again. The map is session-scoped, like the reviewed set.
 */

/**
 * Records `draft` under `path` when it differs from the server content.
 * Editing back to the server content is clean and drops any stored draft.
 *
 * @returns true when a draft was stored.
 */
export function rememberDraft(
  drafts: Map<string, string>,
  path: string,
  draft: string,
  serverContent: string,
): boolean {
  if (draft === serverContent) {
    drafts.delete(path);
    return false;
  }
  drafts.set(path, draft);
  return true;
}

/**
 * The modified-side content to show when opening `path`: a preserved draft if
 * one exists, otherwise the freshly read server content.
 */
export function draftAfterNavigation(
  drafts: ReadonlyMap<string, string>,
  path: string,
  serverContent: string,
): string {
  return drafts.get(path) ?? serverContent;
}
