import { describe, expect, test } from "bun:test";
import type { BackgroundTask } from "./background-tasks.ts";
import { buildSubagentTree } from "./subagent-tree.ts";

function mkTask(
  partial: Partial<BackgroundTask> & { taskId: string; startedAt: string },
): BackgroundTask {
  return {
    description: partial.taskId,
    ambient: false,
    status: "running",
    updatedAt: partial.startedAt,
    ...partial,
  } as BackgroundTask;
}

describe("buildSubagentTree", () => {
  test("flat list of root tasks", () => {
    const tasks = [
      mkTask({ taskId: "a", startedAt: "2020-01-01T00:00:00Z" }),
      mkTask({ taskId: "b", startedAt: "2020-01-01T00:00:01Z" }),
    ];
    const tree = buildSubagentTree(tasks);
    expect(tree).toHaveLength(2);
    expect(tree[0]?.task.taskId).toBe("a");
    expect(tree[0]?.level).toBe(0);
    expect(tree[0]?.children).toHaveLength(0);
  });

  test("2-level parent-child hierarchy", () => {
    const tasks = [
      mkTask({ taskId: "parent", startedAt: "2020-01-01T00:00:00Z" }),
      mkTask({ taskId: "child", startedAt: "2020-01-01T00:00:01Z", parentTaskId: "parent" }),
    ];
    const tree = buildSubagentTree(tasks);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.task.taskId).toBe("parent");
    expect(tree[0]?.level).toBe(0);
    expect(tree[0]?.children).toHaveLength(1);
    expect(tree[0]?.children[0]?.task.taskId).toBe("child");
    expect(tree[0]?.children[0]?.level).toBe(1);
  });

  test("deep nesting", () => {
    const tasks = [
      mkTask({ taskId: "root", startedAt: "2020-01-01T00:00:00Z" }),
      mkTask({ taskId: "child", startedAt: "2020-01-01T00:00:01Z", parentTaskId: "root" }),
      mkTask({ taskId: "grand", startedAt: "2020-01-01T00:00:02Z", parentTaskId: "child" }),
    ];
    const tree = buildSubagentTree(tasks);
    expect(tree[0]?.children[0]?.children[0]?.task.taskId).toBe("grand");
    expect(tree[0]?.children[0]?.children[0]?.level).toBe(2);
  });

  test("missing parent handled as root", () => {
    const tasks = [
      mkTask({ taskId: "orphan", startedAt: "2020-01-01T00:00:00Z", parentTaskId: "nope" }),
    ];
    const tree = buildSubagentTree(tasks);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.task.taskId).toBe("orphan");
    expect(tree[0]?.level).toBe(0);
  });

  test("chronological ordering", () => {
    const tasks = [
      mkTask({ taskId: "b", startedAt: "2020-01-01T00:00:02Z" }),
      mkTask({ taskId: "a", startedAt: "2020-01-01T00:00:01Z" }),
      mkTask({ taskId: "c", startedAt: "2020-01-01T00:00:01Z", parentTaskId: "a" }),
    ];
    const tree = buildSubagentTree(tasks);
    expect(tree.map((n) => n.task.taskId)).toEqual(["a", "b"]);
    // child sorted
    expect(tree[0]?.children.map((n) => n.task.taskId)).toEqual(["c"]);
  });
});
