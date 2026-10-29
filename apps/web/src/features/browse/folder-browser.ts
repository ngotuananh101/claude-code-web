/**
 * Folder browser controller for the workspace discovery modal (§15.1, P3-B).
 *
 * This module is the pure, framework-free logic behind `FolderBrowserModal.vue`.
 * It holds the browser state in a single reactive object and exposes the
 * navigation operations the component calls from DOM events: `navigate`,
 * `selectShortcut`, `goUp`, `selectFolder` and `registerWorkspace`.
 *
 * The controller is created with a `runnerId` and two API stubs (the
 * never-throw `fetchDirectory` and `registerWorkspace` from `browse-api.ts`).
 * A test injects fakes; the real component injects the real functions. The
 * contract mirrors InspectPanel.vue's epoch pattern: a response whose epoch is
 * stale is dropped so a faster second navigation cannot paint an earlier
 * directory's contents under the current path.
 */

import type { FsBrowseResult, FsBrowseShortcut } from "@cc-web/protocol";
import type { BrowseOutcome, RegisterWorkspaceOutcome } from "@/services/browse-api.ts";

export type Crumb = { name: string; path: string };

/** State shape consumed by the component via the returned `state` ref. */
export type FolderBrowserState = {
  runnerId: string;
  currentPath: string;
  parentPath: string | null;
  entries: FsBrowseResult["entries"];
  shortcuts: FsBrowseShortcut[];
  loading: boolean;
  error: string | null;
  /** The path the operator has clicked on / is about to confirm. */
  selectedPath: string;
};

export type FolderBrowserApi = {
  state: { value: FolderBrowserState };
  navigate: (path: string) => Promise<void>;
  selectShortcut: (shortcut: FsBrowseShortcut) => Promise<void>;
  goUp: () => Promise<void>;
  selectFolder: (path: string) => void;
  registerWorkspace: () => Promise<RegisterWorkspaceOutcome>;
};

/**
 * Path segments, tolerating stray leading, trailing and doubled slashes.
 * Shared with the breadcrumbs split — a directory that starts or ends with
 * `/` should not yield an empty crumb.
 */
function segments(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

/**
 * Breadcrumb splitting for the folder browser.
 *
 * Each crumb carries the cumulative path up to and including that segment, so a
 * click on any crumb jumps to the directory at that prefix. The root (empty
 * path) yields no crumbs — clicking the workspace root is the "go home" shortcut,
 * not a crumb.
 */
export function breadcrumbs(path: string): Crumb[] {
  const crumbs: Crumb[] = [];
  let current = "";
  for (const segment of segments(path)) {
    current = joinPath(current, segment);
    crumbs.push({ name: segment, path: current });
  }
  return crumbs;
}

/**
 * The directory above `path`; undefined at the root, which has no parent.
 *
 * Unlike `paths.ts` (which works on relative workspace paths), this operates on
 * the absolute runner paths returned by the browse API: `/srv/proj` →
 * `/srv`, and `/` → undefined.
 */
export function parentPathOf(path: string): string | undefined {
  const parts = segments(path);
  if (parts.length === 0) return undefined;
  const parent = parts.slice(0, -1).join("/");
  // Re-add the leading slash for absolute paths so `/srv/proj` → `/srv`.
  return path.startsWith("/") ? `/${parent}` : parent;
}

export function joinPath(directory: string, name: string): string {
  if (directory === "") return name;
  if (directory.endsWith("/")) return `${directory}${name}`;
  return `${directory}/${name}`;
}

/**
 * Build a folder-browser controller.
 *
 * `api` is injected so tests use fakes and the real component passes the real
 * `browse-api` functions. Both return never-throw outcome objects.
 */
export function createFolderBrowser(
  runnerId: string,
  api: {
    fetchDirectory: (runnerId: string, path?: string) => Promise<BrowseOutcome>;
    registerWorkspace: (runnerId: string, path: string) => Promise<RegisterWorkspaceOutcome>;
  },
): FolderBrowserApi {
  const state = {
    value: {
      runnerId,
      currentPath: "",
      parentPath: null as string | null,
      entries: [] as FsBrowseResult["entries"],
      shortcuts: [] as FsBrowseShortcut[],
      loading: false,
      error: null as string | null,
      selectedPath: "",
    },
  };

  /** Epoch counter so a stale response from a previous navigation is ignored. */
  let epoch = 0;

  async function load(path: string): Promise<void> {
    const current = ++epoch;
    state.value.loading = true;
    state.value.error = null;

    const outcome = await api.fetchDirectory(state.value.runnerId, path);

    // A faster second navigation made this response stale — drop it silently.
    if (current !== epoch) return;

    state.value.loading = false;

    if (!outcome.ok) {
      state.value.error = outcome.message;
      return;
    }

    const result = outcome.value;
    state.value.currentPath = result.currentPath;
    state.value.parentPath = result.parentPath;
    state.value.entries = result.entries;
    state.value.shortcuts = result.shortcuts;
    // Selecting a folder defaults to the directory just browsed.
    state.value.selectedPath = result.currentPath;
  }

  return {
    state,

    /** Navigate to `path` (may be absolute or relative) and load its listing. */
    async navigate(path: string): Promise<void> {
      await load(path);
    },

    /** Jump to a shortcut's path, clearing the current listing first. */
    async selectShortcut(shortcut: FsBrowseShortcut): Promise<void> {
      await load(shortcut.path);
    },

    /** Navigate to the parent of the current path, if one exists. */
    async goUp(): Promise<void> {
      const parent = state.value.parentPath;
      if (parent === null) return;
      await load(parent);
    },

    /** Mark a folder as the selected one without navigating into it. */
    selectFolder(path: string): void {
      state.value.selectedPath = path;
    },

    /**
     * Register the currently selected path as a workspace on the runner.
     *
     * The path forwarded is the entry the operator highlighted, not the
     * directory currently open in the browser — the component calls
     * `selectFolder` on every click so `selectedPath` always leads.
     */
    async registerWorkspace(): Promise<RegisterWorkspaceOutcome> {
      return api.registerWorkspace(state.value.runnerId, state.value.selectedPath);
    },
  };
}
