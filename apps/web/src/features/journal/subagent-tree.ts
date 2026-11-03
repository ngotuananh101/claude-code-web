import type { BackgroundTask } from "./background-tasks.ts";

export type SubagentTreeNode = {
  task: BackgroundTask;
  children: SubagentTreeNode[];
  level: number;
};

function compareTasks(a: BackgroundTask, b: BackgroundTask): number {
  if (a.startedAt !== b.startedAt) {
    return a.startedAt < b.startedAt ? -1 : 1;
  }
  if (a.taskId !== b.taskId) {
    return a.taskId < b.taskId ? -1 : 1;
  }
  return 0;
}

export function buildSubagentTree(tasks: Iterable<BackgroundTask>): SubagentTreeNode[] {
  const list = Array.from(tasks);
  const byId = new Map<string, BackgroundTask>();
  for (const t of list) byId.set(t.taskId, t);

  const childrenByParent = new Map<string, BackgroundTask[]>();
  const roots: BackgroundTask[] = [];
  for (const t of list) {
    const pid = t.parentTaskId;
    if (pid !== undefined && byId.has(pid)) {
      const arr = childrenByParent.get(pid) ?? [];
      arr.push(t);
      childrenByParent.set(pid, arr);
    } else {
      roots.push(t);
    }
  }

  roots.sort(compareTasks);

  function build(task: BackgroundTask, level: number): SubagentTreeNode {
    const kids = (childrenByParent.get(task.taskId) ?? []).slice().sort(compareTasks);
    return {
      task,
      level,
      children: kids.map((c) => build(c, level + 1)),
    };
  }

  return roots.map((t) => build(t, 0));
}

export function aggregateTokens(node: SubagentTreeNode): number {
  const own = node.task.usage?.totalTokens ?? 0;
  return own + node.children.reduce((sum, c) => sum + aggregateTokens(c), 0);
}
