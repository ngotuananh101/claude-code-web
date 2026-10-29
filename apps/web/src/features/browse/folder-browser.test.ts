import { describe, expect, test } from "bun:test";
import type { FsBrowseResult } from "@cc-web/protocol";
import { breadcrumbs, createFolderBrowser, parentPathOf } from "./folder-browser.ts";

/**
 * Folder browser controller / pure helpers (§15.1, P3-B).
 *
 * State management, breadcrumb splitting, navigation logic and the API calls that
 * back them are tested here as pure functions — no Vue, no @vue/compiler-sfc.
 * The component (FolderBrowserModal.vue) only wires the DOM to this controller.
 *
 * The controller is created with a `runnerId` and two API stubs:
 * `fetchDirectory` and `registerWorkspace`. Both return the never-throw outcome
 * types from browse-api, so the controller never needs its own try/catch.
 */

function sampleBrowseResult(
  path: string,
  parent: string | null,
  dirNames: string[],
): FsBrowseResult {
  return {
    op: "fs.browse",
    currentPath: path,
    parentPath: parent,
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

describe("breadcrumbs", () => {
  test("root path yields no crumbs", () => {
    expect(breadcrumbs("")).toEqual([]);
  });

  test("root slash yields no crumbs", () => {
    expect(breadcrumbs("/")).toEqual([]);
  });

  test("each crumb carries the cumulative path up to that segment", () => {
    expect(breadcrumbs("src/app/main.ts")).toEqual([
      { name: "src", path: "src" },
      { name: "app", path: "src/app" },
      { name: "main.ts", path: "src/app/main.ts" },
    ]);
  });

  test("stray leading, trailing and doubled slashes do not produce empty crumbs", () => {
    expect(breadcrumbs("/src//app/")).toEqual([
      { name: "src", path: "src" },
      { name: "app", path: "src/app" },
    ]);
  });

  test("a single segment yields one crumb with empty path prefix", () => {
    expect(breadcrumbs("home")).toEqual([{ name: "home", path: "home" }]);
  });
});

describe("parentPathOf", () => {
  test("root has no parent", () => {
    expect(parentPathOf("")).toBeUndefined();
  });

  test("a top-level entry's parent is the root", () => {
    expect(parentPathOf("src")).toBe("");
  });

  test("a nested entry's parent is its directory", () => {
    expect(parentPathOf("src/app/main.ts")).toBe("src/app");
  });
});

describe("createFolderBrowser", () => {
  const okResult = sampleBrowseResult("/srv/proj", "/", ["packages", "apps"]);

  test("initial state is not loading and has no entries", () => {
    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: () => Promise.resolve({ ok: false, code: "error", message: "" }),
      registerWorkspace: () => Promise.resolve({ ok: false, code: "error", message: "" }),
    });

    expect(browser.state.value).toEqual({
      runnerId: "runner-a",
      currentPath: "",
      parentPath: null,
      entries: [],
      shortcuts: [],
      loading: false,
      error: null,
      selectedPath: "",
    });
  });

  test("navigate loads a directory and populates entries, shortcuts, parentPath", async () => {
    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: (runnerId, path) => {
        expect(runnerId).toBe("runner-a");
        expect(path).toBe("packages");
        return Promise.resolve({ ok: true, value: okResult });
      },
      registerWorkspace: () => Promise.resolve({ ok: false, code: "error", message: "" }),
    });

    await browser.navigate("packages");

    expect(browser.state.value.currentPath).toBe("/srv/proj");
    expect(browser.state.value.parentPath).toBe("/");
    expect(browser.state.value.entries).toEqual(okResult.entries);
    expect(browser.state.value.shortcuts).toEqual(okResult.shortcuts);
    expect(browser.state.value.loading).toBe(false);
    expect(browser.state.value.error).toBeNull();
  });

  test("navigate sets loading=true while fetching and false on success", async () => {
    let resolveFn: (v: { ok: true; value: FsBrowseResult }) => void = () => {};
    const promise = new Promise<{ ok: true; value: FsBrowseResult }>((resolve) => {
      resolveFn = resolve;
    });

    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: () => promise,
      registerWorkspace: () => Promise.resolve({ ok: false, code: "error", message: "" }),
    });

    const navPromise = browser.navigate("packages");

    // While the fetch is in flight, loading should be true.
    expect(browser.state.value.loading).toBe(true);
    expect(browser.state.value.error).toBeNull();

    resolveFn({ ok: true, value: okResult });
    await navPromise;

    expect(browser.state.value.loading).toBe(false);
  });

  test("navigate collapses a failure into error state", async () => {
    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: () =>
        Promise.resolve({ ok: false, code: "RUNNER_NOT_FOUND", message: "Runner không sẵn sàng." }),
      registerWorkspace: () => Promise.resolve({ ok: false, code: "error", message: "" }),
    });

    await browser.navigate("packages");

    expect(browser.state.value.loading).toBe(false);
    expect(browser.state.value.error).toBe("Runner không sẵn sàng.");
  });

  test("navigate sets selectedPath to the new currentPath on success", async () => {
    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: () => Promise.resolve({ ok: true, value: okResult }),
      registerWorkspace: () => Promise.resolve({ ok: false, code: "error", message: "" }),
    });

    await browser.navigate("packages");

    expect(browser.state.value.selectedPath).toBe("/srv/proj");
  });

  test("selectShortcut navigates to the shortcut's path", async () => {
    let calledPath: string | undefined;
    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: (_runnerId, path) => {
        calledPath = path;
        return Promise.resolve({ ok: true, value: okResult });
      },
      registerWorkspace: () => Promise.resolve({ ok: false, code: "error", message: "" }),
    });

    await browser.selectShortcut({ label: "~", path: "/root" });

    expect(calledPath).toBe("/root");
  });

  test("goUp navigates to parentPath when one exists", async () => {
    let calledPath: string | undefined;
    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: (_runnerId, path?: string) => {
        calledPath = path;
        return Promise.resolve({ ok: true, value: okResult });
      },
      registerWorkspace: () => Promise.resolve({ ok: false, code: "error", message: "" }),
    });

    // First populate the state with a parent path.
    await browser.navigate("packages");

    await browser.goUp();

    expect(calledPath).toBe("/");
  });

  test("goUp does nothing when at the root (no parent)", async () => {
    let callCount = 0;
    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: () => {
        callCount++;
        return Promise.resolve({
          ok: true,
          value: sampleBrowseResult("/", null, ["home"]),
        });
      },
      registerWorkspace: () => Promise.resolve({ ok: false, code: "error", message: "" }),
    });

    await browser.navigate("");
    await browser.goUp();

    // Only the initial navigate call, no goUp call.
    expect(callCount).toBe(1);
  });

  test("selectFolder sets selectedPath without changing currentPath", async () => {
    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: () => Promise.resolve({ ok: true, value: okResult }),
      registerWorkspace: () => Promise.resolve({ ok: false, code: "error", message: "" }),
    });

    await browser.navigate("");

    browser.selectFolder("packages");

    expect(browser.state.value.selectedPath).toBe("packages");
    // currentPath should remain unchanged.
    expect(browser.state.value.currentPath).toBe("/srv/proj");
  });

  test("registerWorkspace calls the API with runnerId and selectedPath on success", async () => {
    let capturedRunnerId = "";
    let capturedPath = "";
    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: () => Promise.resolve({ ok: true, value: okResult }),
      registerWorkspace: (runnerId, path) => {
        capturedRunnerId = runnerId;
        capturedPath = path;
        return Promise.resolve({
          ok: true,
          value: { workspaceId: "ws-1", path: "/srv/proj", runnerId: "runner-a" },
        });
      },
    });

    await browser.navigate("");
    browser.selectFolder("packages");

    const outcome = await browser.registerWorkspace();

    expect(capturedRunnerId).toBe("runner-a");
    expect(capturedPath).toBe("packages");
    expect(outcome).toEqual({
      ok: true,
      value: { workspaceId: "ws-1", path: "/srv/proj", runnerId: "runner-a" },
    });
  });

  test("registerWorkspace surfaces failure without throwing", async () => {
    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: () => Promise.resolve({ ok: true, value: okResult }),
      registerWorkspace: () =>
        Promise.resolve({ ok: false, code: "error", message: "Không kết nối được máy chủ." }),
    });

    await browser.navigate("");
    browser.selectFolder("packages");

    const outcome = await browser.registerWorkspace();

    expect(outcome).toEqual({
      ok: false,
      code: "error",
      message: "Không kết nối được máy chủ.",
    });
  });

  test("entries are cleared and replaced on each successful navigate", async () => {
    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: (_runnerId, path) => {
        if (path === "packages") {
          return Promise.resolve({
            ok: true,
            value: sampleBrowseResult("/srv/proj/packages", "/srv/proj", ["web", "api"]),
          });
        }
        return Promise.resolve({
          ok: true,
          value: sampleBrowseResult("/srv/proj", "/", ["packages", "apps"]),
        });
      },
      registerWorkspace: () => Promise.resolve({ ok: false, code: "error", message: "" }),
    });

    await browser.navigate("");
    expect(browser.state.value.entries.map((e) => e.name)).toEqual(["packages", "apps"]);

    await browser.navigate("packages");
    expect(browser.state.value.entries.map((e) => e.name)).toEqual(["web", "api"]);
  });

  test("error state is cleared when a new navigation succeeds", async () => {
    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: () =>
        Promise.resolve({ ok: true, value: sampleBrowseResult("/srv/proj", "/", ["packages"]) }),
      registerWorkspace: () => Promise.resolve({ ok: false, code: "error", message: "" }),
    });

    await browser.navigate("packages");
    // Manually set error state.
    browser.state.value.error = "previous error";

    await browser.navigate("");

    expect(browser.state.value.error).toBeNull();
  });

  test("selectedPath defaults to empty string and is updated by navigate", async () => {
    const browser = createFolderBrowser("runner-a", {
      fetchDirectory: () => Promise.resolve({ ok: true, value: okResult }),
      registerWorkspace: () => Promise.resolve({ ok: false, code: "error", message: "" }),
    });

    expect(browser.state.value.selectedPath).toBe("");

    await browser.navigate("");

    expect(browser.state.value.selectedPath).toBe("/srv/proj");
  });
});
