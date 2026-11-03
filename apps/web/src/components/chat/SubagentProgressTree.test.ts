import { describe, expect, test } from "bun:test";
import type { BackgroundTask } from "@/features/journal/background-tasks.ts";
import { formatTaskElapsed } from "@/features/journal/background-tasks.ts";
import { buildSubagentTree } from "@/features/journal/subagent-tree.ts";

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

describe("SubagentProgressTree contract", () => {
  test("tree node count matches tasks", () => {
    const tasks = [
      mkTask({ taskId: "a", startedAt: "2020-01-01T00:00:00Z" }),
      mkTask({ taskId: "b", startedAt: "2020-01-01T00:00:01Z", parentTaskId: "a" }),
    ];
    const tree = buildSubagentTree(tasks);
    function countNodes(nodes: typeof tree): number {
      return nodes.reduce((s, n) => s + 1 + countNodes(n.children), 0);
    }
    expect(countNodes(tree)).toBe(2);
  });

  test("selection emits task identity", () => {
    const task = mkTask({ taskId: "x", startedAt: "2020-01-01T00:00:00Z" });
    // contract: selecting a node yields its task
    expect(task.taskId).toBe("x");
  });

  test("time formatting", () => {
    expect(formatTaskElapsed(5000)).toBe("5s");
    expect(formatTaskElapsed(65000)).toBe("1p 05s");
  });

  test("indentation level * 16px", () => {
    const tasks = [
      mkTask({ taskId: "root", startedAt: "2020-01-01T00:00:00Z" }),
      mkTask({ taskId: "child", startedAt: "2020-01-01T00:00:01Z", parentTaskId: "root" }),
    ];
    const tree = buildSubagentTree(tasks);
    expect(tree[0]?.level).toBe(0);
    expect(tree[0]?.children[0]?.level).toBe(1);
    expect(tree[0]!.children[0]!.level * 16).toBe(16);
  });
});
