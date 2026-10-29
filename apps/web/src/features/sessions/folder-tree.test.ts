import { describe, expect, test } from "bun:test";
import {
  compositeIdFor,
  folderBasename,
  groupFoldersByRunner,
  shortRunnerId,
} from "./folder-tree.ts";

describe("folder-tree helpers", () => {
  test("shortRunnerId takes the first 8 characters", () => {
    expect(shortRunnerId("81628cd3-821f-425e-8bf4-ade7dd2b2f51")).toBe("81628cd3");
    expect(shortRunnerId("abc")).toBe("abc");
  });

  test("folderBasename extracts trailing path component", () => {
    expect(folderBasename("/srv/repos/my-project")).toBe("my-project");
    expect(folderBasename("/srv/repos/my-project/")).toBe("my-project");
    expect(folderBasename("/")).toBe("/");
    expect(folderBasename("project")).toBe("project");
  });

  test("compositeIdFor joins runnerId and workspaceId with a slash", () => {
    expect(compositeIdFor("runner-1", "ws-abc")).toBe("runner-1/ws-abc");
  });

  test("groupFoldersByRunner groups workspaces by runner and sorts paths", () => {
    const workspaces = [
      {
        workspaceId: "w2",
        runnerId: "runner-b",
        path: "/srv/beta",
        branches: [],
        createdAt: 100,
      },
      {
        workspaceId: "w1",
        runnerId: "runner-a",
        path: "/srv/alpha",
        branches: [],
        createdAt: 100,
      },
      {
        workspaceId: "w3",
        runnerId: "runner-a",
        path: "/srv/aaa",
        branches: [],
        createdAt: 100,
      },
    ];

    const groups = groupFoldersByRunner(workspaces);
    expect(groups.map((g) => g.runnerId)).toEqual(["runner-a", "runner-b"]);
    expect(groups[0]?.folders.map((f) => f.path)).toEqual(["/srv/aaa", "/srv/alpha"]);
    expect(groups[0]?.folders[0]?.compositeId).toBe("runner-a/w3");
  });
});
