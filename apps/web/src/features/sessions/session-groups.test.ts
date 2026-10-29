import { describe, expect, test } from "bun:test";
import {
  groupSessions,
  nextGrouping,
  nextSort,
  parseGrouping,
  parseSort,
  type SessionSort,
} from "./session-groups.ts";

type Workspace = {
  workspaceId: string;
  runnerId: string;
  path: string;
  branches: string[];
  createdAt: number;
};

type Session = {
  sessionId: string;
  watermark: number;
  eventCount: number;
  lastEventType: string | null;
  lastIngestedAt: number;
  live: boolean;
  runnerId: string | null;
  workspaceId: string | null;
  sdkSessionId: string | null;
};

function workspace(runnerId: string, workspaceId: string, path: string): Workspace {
  return { runnerId, workspaceId, path, branches: [], createdAt: 100 };
}

function session(
  id: string,
  runnerId: string | null,
  workspaceId: string | null,
  at: number,
): Session {
  return {
    sessionId: id,
    watermark: at,
    eventCount: 1,
    lastEventType: null,
    lastIngestedAt: at,
    live: false,
    runnerId,
    workspaceId,
    sdkSessionId: null,
  };
}

const workspaces: Workspace[] = [
  workspace("runner-1", "ws-1", "/mnt/Data/repo-a"),
  workspace("runner-1", "ws-2", "/mnt/Data/repo-b"),
  workspace("runner-2", "ws-3", "/srv/repo-c"),
];

// Ids and timestamps are deliberately anti-correlated: alphabetical order,
// newest-first order and oldest-first order each differ from the other two,
// for both the groups and the rows inside a group. A test that asserted a
// coinciding order could pass with the comparator inverted.
const sessions: Session[] = [
  session("sess-charlie", "runner-1", "ws-1", 3000),
  session("sess-alpha", "runner-1", "ws-1", 1000),
  session("sess-bravo", "runner-1", "ws-1", 5000),
  session("sess-delta", "runner-1", "ws-2", 9000),
  session("sess-echo", "runner-2", "ws-3", 500),
];

describe("groupSessions — project grouping", () => {
  test("groups by folder, newest folder first, rows newest first", () => {
    const groups = groupSessions(sessions, workspaces, "project", "recent");

    expect(groups.map((g) => g.label)).toEqual(["repo-b", "repo-a", "repo-c"]);
    expect(groups[1]?.detail).toBe("runner-1");
    expect(groups[1]?.title).toBe("/mnt/Data/repo-a");
    expect(groups[1]?.sessions.map((row) => row.session.sessionId)).toEqual([
      "sess-bravo",
      "sess-charlie",
      "sess-alpha",
    ]);
    // Every row already knows its own folder, whichever group it is listed in.
    expect(groups[1]?.sessions.map((row) => row.folder)).toEqual(["repo-a", "repo-a", "repo-a"]);
  });

  test("oldest sort flips rows and folder order", () => {
    const groups = groupSessions(sessions, workspaces, "project", "oldest");

    expect(groups.map((g) => g.label)).toEqual(["repo-c", "repo-a", "repo-b"]);
    expect(groups[1]?.sessions.map((row) => row.session.sessionId)).toEqual([
      "sess-alpha",
      "sess-charlie",
      "sess-bravo",
    ]);
  });

  test("name sort orders rows and groups by session id", () => {
    const groups = groupSessions(sessions, workspaces, "project", "name");

    expect(groups.map((g) => g.label)).toEqual(["repo-a", "repo-b", "repo-c"]);
    expect(groups[0]?.sessions.map((row) => row.session.sessionId)).toEqual([
      "sess-alpha",
      "sess-bravo",
      "sess-charlie",
    ]);
  });

  test("leaves out a session with no folder pin", () => {
    const withUnpinned = [...sessions, session("sess-orphan", null, null, 9000)];
    const groups = groupSessions(withUnpinned, workspaces, "project", "recent");

    const ids = groups.flatMap((group) => group.sessions.map((row) => row.session.sessionId));
    expect(ids).not.toContain("sess-orphan");
    expect(groups).toHaveLength(3);
  });
});

describe("groupSessions — runner grouping", () => {
  test("groups by runner, heading is the short id, detail is the count", () => {
    const groups = groupSessions(sessions, workspaces, "runner", "recent");

    expect(groups.map((g) => g.key)).toEqual(["runner-1", "runner-2"]);
    expect(groups[0]?.label).toBe("runner-1");
    expect(groups[0]?.detail).toBe("4 phiên");
    expect(groups[0]?.title).toBe("runner-1 (4 phiên)");
    expect(groups[0]?.sessions.map((row) => row.session.sessionId)).toEqual([
      "sess-delta",
      "sess-bravo",
      "sess-charlie",
      "sess-alpha",
    ]);
    // The folder still rides on each row, so a runner view never loses it.
    expect(groups[0]?.sessions.map((row) => row.folder)).toEqual([
      "repo-b",
      "repo-a",
      "repo-a",
      "repo-a",
    ]);
  });

  test("leaves out a session with no folder pin", () => {
    const withUnpinned = [...sessions, session("sess-orphan", null, null, 9000)];
    const groups = groupSessions(withUnpinned, workspaces, "runner", "recent");

    const ids = groups.flatMap((group) => group.sessions.map((row) => row.session.sessionId));
    expect(ids).not.toContain("sess-orphan");
    expect(groups.map((g) => g.key)).toEqual(["runner-1", "runner-2"]);
  });

  test("a folder the runner no longer declares shows no folder name", () => {
    const stale = [session("sess-x", "runner-1", "ws-gone", 100)];
    const groups = groupSessions(stale, workspaces, "runner", "recent");

    expect(groups[0]?.sessions[0]?.folder).toBeNull();
    expect(groups[0]?.sessions[0]?.session.sessionId).toBe("sess-x");
  });

  test("a folder the control plane no longer declares heads by workspace id, not path", () => {
    const stale = [session("sess-x", "runner-1", "ws-gone", 100)];
    const groups = groupSessions(stale, workspaces, "project", "recent");

    expect(groups[0]?.label).toBe("ws-gone");
    expect(groups[0]?.title).toBe("runner-1/ws-gone");
  });
});

describe("preference helpers", () => {
  test("grouping flips between the two shapes", () => {
    expect(nextGrouping("project")).toBe("runner");
    expect(nextGrouping("runner")).toBe("project");
  });

  test("sort cycles recent → oldest → name → recent", () => {
    expect(nextSort("recent")).toBe("oldest");
    expect(nextSort("oldest")).toBe("name");
    expect(nextSort("name")).toBe("recent");
  });

  test("an unknown sort value cycles back to the default", () => {
    expect(nextSort("nonsense" as SessionSort)).toBe("recent");
  });

  test("stored values fall back to the defaults", () => {
    expect(parseGrouping(null)).toBe("project");
    expect(parseGrouping("nonsense")).toBe("project");
    expect(parseGrouping("runner")).toBe("runner");
    expect(parseSort(null)).toBe("recent");
    expect(parseSort("nonsense")).toBe("recent");
    expect(parseSort("name")).toBe("name");
  });
});
