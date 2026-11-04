<script setup lang="ts">
import { ChevronDown, ChevronRight } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { BackgroundTask } from "@/features/journal/background-tasks.ts";
import { formatTaskElapsed } from "@/features/journal/background-tasks.ts";
import { buildSubagentTree, type SubagentTreeNode } from "@/features/journal/subagent-tree.ts";

const props = defineProps<{
  tasks: BackgroundTask[];
}>();

const emit = defineEmits<(e: "select-task", task: BackgroundTask) => void>();

const tree = computed(() => buildSubagentTree(props.tasks));

const collapsed = ref<Set<string>>(new Set());

const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});
onBeforeUnmount(() => {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
});

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
  // Touch `now` so the template re-renders as time advances.
  const current = now.value;
  return formatTaskElapsed(current - started);
}

function labelFor(task: BackgroundTask): string {
  return task.description || task.subagentType || task.workflowName || task.taskType || task.taskId;
}

// Nesting is unbounded in the journal but the screen is not: past the third
// level the indent stops growing so a deep tree cannot push its labels off a
// phone's edge.
function indentFor(level: number): string {
  return `${Math.min(level, 3) * 12}px`;
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
      class="flex min-h-9 items-center gap-2 text-[13px] sm:min-h-0"
      :style="{ paddingLeft: indentFor(node.level) }"
    >
      <button
        v-if="node.children.length > 0"
        type="button"
        class="-m-2 shrink-0 p-2 text-muted-foreground sm:m-0 sm:p-0"
        @click.stop="toggle(node.task.taskId)"
      >
        <ChevronDown v-if="!collapsed.has(node.task.taskId)" :size="12" />
        <ChevronRight v-else :size="12" />
      </button>
      <span v-else class="inline-block w-3 shrink-0" />

      <button
        type="button"
        class="flex min-h-9 min-w-0 flex-1 items-center gap-2 text-left hover:bg-muted/40 rounded px-1 sm:min-h-0"
        @click="emit('select-task', node.task)"
      >
        <i class="size-[7px] shrink-0 rounded-full" :class="dotClass(node.task.status)" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate" :title="labelFor(node.task)">{{ labelFor(node.task) }}</span>
        <span
          v-if="node.task.lastToolName"
          class="max-w-24 shrink-0 truncate rounded border border-border px-1 font-mono text-[10px] text-muted-foreground"
        >
          {{ node.task.lastToolName }}
        </span>
        <span
          v-if="node.task.usage"
          class="shrink-0 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground max-sm:hidden"
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