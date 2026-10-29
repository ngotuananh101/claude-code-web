import { describe, expect, test } from "bun:test";
import {
  compositeIdFor,
  folderBasename,
  groupFoldersByRunner,
  groupSessionsByFolder,
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

  test("groupSessionsByFolder groups sessions under their owning folders", () => {
    const workspaces = [
      {
        workspaceId: "ws-1",
        runnerId: "runner-1",
        path: "/mnt/Data/repo-a",
        branches: [],
        createdAt: 100,
      },
      {
        workspaceId: "ws-2",
        runnerId: "runner-2",
        path: "/mnt/Data/repo-b",
        branches: [],
        createdAt: 100,
      },
    ];

    const sessions = [
      {
        sessionId: "sess-1",
        watermark: 1,
        eventCount: 5,
        lastEventType: null,
        lastIngestedAt: 1000,
        live: false,
        runnerId: "runner-1",
        workspaceId: "ws-1",
        sdkSessionId: null,
      },
      {
        sessionId: "sess-2",
        watermark: 2,
        eventCount: 10,
        lastEventType: null,
        lastIngestedAt: 2000,
        live: true,
        runnerId: "runner-1",
        workspaceId: "ws-1",
        sdkSessionId: null,
      },
      {
        sessionId: "sess-3",
        watermark: 3,
        eventCount: 2,
        lastEventType: null,
        lastIngestedAt: 3000,
        live: false,
        runnerId: "runner-2",
        workspaceId: "ws-2",
        sdkSessionId: null,
      },
      {
        sessionId: "sess-unpinned",
        watermark: 0,
        eventCount: 0,
        lastEventType: null,
        lastIngestedAt: 500,
        live: false,
        runnerId: null,
        workspaceId: null,
        sdkSessionId: null,
      },
    ];

    const groups = groupSessionsByFolder(sessions, workspaces);
    expect(groups.length).toBe(2);

    // Sorted by most recent activity: repo-b (3000) > repo-a (2000)
    expect(groups[0]?.path).toBe("/mnt/Data/repo-b");
    expect(groups[0]?.displayName).toBe("repo-b");
    expect(groups[0]?.sessions.map((s) => s.sessionId)).toEqual(["sess-3"]);

    expect(groups[1]?.path).toBe("/mnt/Data/repo-a");
    expect(groups[1]?.displayName).toBe("repo-a");
    expect(groups[1]?.sessions.map((s) => s.sessionId)).toEqual(["sess-2", "sess-1"]);

    // A session with no folder pin has no folder to be listed under.
    expect(groups.some((g) => g.sessions.some((s) => s.sessionId === "sess-unpinned"))).toBe(false);
  });
});
