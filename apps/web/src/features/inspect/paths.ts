/**
 * Path arithmetic for the Files panel (P3-A ruling 12).
 *
 * One directory per call is the runner's bound, so the panel navigates by
 * composing paths from what it already knows — no recursive tree, no second
 * request to walk up. These are the pure pieces of that navigation.
 */

export type Crumb = { name: string; path: string };

/** Path segments, tolerating stray leading, trailing and doubled slashes. */
function segments(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

export function breadcrumbs(path: string): Crumb[] {
  const crumbs: Crumb[] = [];
  let current = "";
  for (const segment of segments(path)) {
    current = joinPath(current, segment);
    crumbs.push({ name: segment, path: current });
  }
  return crumbs;
}

/** The directory above `path`; undefined at the root, which has no parent. */
export function parentPath(path: string): string | undefined {
  const parts = segments(path);
  if (parts.length === 0) return undefined;
  return parts.slice(0, -1).join("/");
}

export function joinPath(directory: string, name: string): string {
  return directory === "" ? name : `${directory}/${name}`;
}
