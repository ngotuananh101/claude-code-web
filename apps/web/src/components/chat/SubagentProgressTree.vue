<script setup lang="ts">
import { ChevronDown, ChevronRight } from "@lucide/vue";
import { computed, ref } from "vue";
import type { BackgroundTask } from "@/features/journal/background-tasks.ts";
import { formatTaskElapsed } from "@/features/journal/background-tasks.ts";
import { buildSubagentTree, type SubagentTreeNode } from "@/features/journal/subagent-tree.ts";

const props = defineProps<{
  tasks: BackgroundTask[];
}>();

const emit = defineEmits<(e: "select-task", task: BackgroundTask) => void>();

const tree = computed(() => buildSubagentTree(props.tasks));

const collapsed = ref<Set<string>>(new Set());

function toggle(taskId: string): void {
  const next = new Set(collapsed.value);
  if (next.has(taskId)) next.delete(taskId);
  else next.add(taskId);
  collapsed.value = next;
}

const visible = computed<SubagentTreeNode[]>(() => {
  const result: SubagentTreeNode[] = [];
  function walk(node: SubagentTreeNode): void {
    result.push(node);
    if (!collapsed.value.has(node.task.taskId)) {
      for (const c of node.children) walk(c);
    }
  }
  for (const root of tree.value) walk(root);
  return result;
});

function elapsedFor(task: BackgroundTask): string {
  const started = Date.parse(task.startedAt);
  if (Number.isNaN(started)) return "";
  return formatTaskElapsed(Date.now() - started);
}

function labelFor(task: BackgroundTask): string {
  return task.description || task.subagentType || task.workflowName || task.taskType || task.taskId;
}

function dotClass(status: BackgroundTask["status"]): string {
  switch (status) {
    case "running":
      return "bg-primary animate-pulse";
    case "completed":
      return "bg-primary";
    case "failed":
      return "bg-destructive";
    case "stopped":
      return "bg-muted-foreground";
  }
}
</script>

<template>
  <ul class="space-y-1">
    <li
      v-for="node in visible"
      :key="node.task.taskId"
      class="flex items-center gap-2 text-[13px]"
      :style="{ paddingLeft: `${node.level * 16}px` }"
    >
      <button
        v-if="node.children.length > 0"
        type="button"
        class="shrink-0 text-muted-foreground"
        @click.stop="toggle(node.task.taskId)"
      >
        <ChevronDown v-if="!collapsed.has(node.task.taskId)" :size="12" />
        <ChevronRight v-else :size="12" />
      </button>
      <span v-else class="inline-block w-3 shrink-0" />

      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-2 text-left hover:bg-muted/40 rounded px-1"
        @click="emit('select-task', node.task)"
      >
        <i class="size-[7px] shrink-0 rounded-full" :class="dotClass(node.task.status)" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate" :title="labelFor(node.task)">{{ labelFor(node.task) }}</span>
        <span
          v-if="node.task.lastToolName"
          class="shrink-0 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground"
        >
          {{ node.task.lastToolName }}
        </span>
        <span
          v-if="node.task.usage"
          class="shrink-0 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground"
        >
          {{ node.task.usage.totalTokens }} tok
        </span>
        <span class="shrink-0 font-mono text-[11px] text-muted-foreground">
          {{ elapsedFor(node.task) }}
        </span>
      </button>
    </li>
  </ul>
</template>