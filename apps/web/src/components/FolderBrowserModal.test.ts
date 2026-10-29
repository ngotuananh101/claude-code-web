import { describe, expect, test } from "bun:test";
import type { FsBrowseResult } from "@cc-web/protocol";
import { isRef } from "vue";
import {
  breadcrumbs,
  type Crumb,
  createFolderBrowser,
  parentPathOf,
} from "../features/browse/folder-browser.ts";

/**
 * Component-level contract tests for FolderBrowserModal.vue (§15.1, P3-B).
 *
 * The Vue SFC cannot be compiled in the Node/Bun test environment without
 * @vue/compiler-sfc, so this file exercises the controller that the component
 * wires to the DOM. It pins the contract the .vue file relies on: the state
 * shape, the navigation operations, the breadcrumbs/parent helpers and the
 * never-throw API outcome handling — everything that keeps the component render
 * deterministic and crash-free.
 */

function makeResult(
  currentPath: string,
  parentPath: string | null,
  dirNames: string[],
): FsBrowseResult {
  return {
    op: "fs.browse",
    currentPath,
    parentPath,
    shortcuts: [{ label: "~", path: "/root" }],
    entries: dirNames.map((name) => ({
      name,
      path: name,
      isDir: true,
      isGitRepo: false,
      hasClaudeProject: false,
    })),
    truncated: false,
  };
}

describe("FolderBrowserModal contract — state shape", () => {
  test("state has the fields the component template binds to", () => {
    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: () => Promise.resolve({ ok: false, code: "error", message: "" }),
      registerWorkspace: () => Promise.resolve({ ok: false, code: "error", message: "" }),
    });

    // state MUST be a real Vue Ref so Vue template proxy unwraps it
    expect(isRef(browser.state)).toBe(true);

    const s = browser.state.value;
    // Every field the .vue template reads must exist with the expected type.
    expect(typeof s.runnerId).toBe("string");
    expect(typeof s.currentPath).toBe("string");
    expect(s.parentPath === null || typeof s.parentPath === "string").toBe(true);
    expect(Array.isArray(s.entries)).toBe(true);
    expect(Array.isArray(s.shortcuts)).toBe(true);
    expect(typeof s.loading).toBe("boolean");
    expect(s.error === null || typeof s.error === "string").toBe(true);
    expect(typeof s.selectedPath).toBe("string");
  });
});

describe("FolderBrowserModal contract — breadcrumbs for the template", () => {
  test("breadcrumbs returns Crumb[] with name+path for template v-for", () => {
    const crumbs: Crumb[] = breadcrumbs("src/app/frontend");
    expect(crumbs.length).toBe(3);
    crumbs.forEach((crumb) => {
      expect(typeof crumb.name).toBe("string");
      expect(typeof crumb.path).toBe("string");
    });
  });

  test("parentPathOf gives the template a clickable parent or null at root", () => {
    expect(parentPathOf("/srv/proj/apps")).toBe("/srv/proj");
    expect(parentPathOf("/")).toBeUndefined();
  });
});

describe("FolderBrowserModal contract — navigation drives re-render", () => {
  test("navigate updates entries so the folder list re-renders", async () => {
    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: () =>
        Promise.resolve({
          ok: true,
          value: makeResult("/srv", "/", ["apps", "docs"]),
        }),
      registerWorkspace: () => Promise.resolve({ ok: false, code: "error", message: "" }),
    });

    await browser.navigate("");
    expect(browser.state.value.entries.map((e) => e.name)).toEqual(["apps", "docs"]);
    expect(browser.state.value.currentPath).toBe("/srv");
  });

  test("selectShortcut navigates to the shortcut path", async () => {
    let captured: string | undefined;
    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: (_runner, path) => {
        captured = path;
        return Promise.resolve({
          ok: true,
          value: makeResult("/root", "/", ["projects"]),
        });
      },
      registerWorkspace: () => Promise.resolve({ ok: false, code: "error", message: "" }),
    });

    await browser.selectShortcut({ label: "~", path: "/root" });
    expect(captured).toBe("/root");
  });

  test("goUp does not navigate when parentPath is null (root)", async () => {
    let calls = 0;
    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: () => {
        calls++;
        return Promise.resolve({
          ok: true,
          value: makeResult("/", null, ["home"]),
        });
      },
      registerWorkspace: () => Promise.resolve({ ok: false, code: "error", message: "" }),
    });

    await browser.navigate("");
    await browser.goUp();
    // Only the initial navigate, goUp skipped at root.
    expect(calls).toBe(1);
  });

  test("selectFolder sets selectedPath without refetching", async () => {
    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: () =>
        Promise.resolve({
          ok: true,
          value: makeResult("/srv/proj", "/", ["packages"]),
        }),
      registerWorkspace: () => Promise.resolve({ ok: false, code: "error", message: "" }),
    });

    await browser.navigate("");
    browser.selectFolder("packages");

    expect(browser.state.value.selectedPath).toBe("packages");
    // currentPath unchanged.
    expect(browser.state.value.currentPath).toBe("/srv/proj");
  });
});

describe("FolderBrowserModal contract — confirm emits select", () => {
  test("registerWorkspace returns ok + workspace path the component emits as select", async () => {
    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: () =>
        Promise.resolve({
          ok: true,
          value: makeResult("/srv/proj", "/", ["packages"]),
        }),
      registerWorkspace: () =>
        Promise.resolve({
          ok: true,
          value: { workspaceId: "ws-1", path: "packages", runnerId: "runner-a" },
        }),
    });

    await browser.navigate("");
    browser.selectFolder("packages");

    const outcome = await browser.registerWorkspace();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.path).toBe("packages");
    }
  });

  test("registerWorkspace failure does not throw — the component stays open", async () => {
    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: () =>
        Promise.resolve({
          ok: true,
          value: makeResult("/srv/proj", "/", ["packages"]),
        }),
      registerWorkspace: () =>
        Promise.resolve({
          ok: false,
          code: "WORKSPACE_BUSY",
          message: "Workspace đang bận — hãy thử lại sau.",
        }),
    });

    await browser.navigate("");
    browser.selectFolder("packages");

    const outcome = await browser.registerWorkspace();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toBe("Workspace đang bận — hãy thử lại sau.");
    }
  });
});
