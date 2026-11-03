<script setup lang="ts">
import { ChevronDown } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import SubagentDetailDialog from "@/components/chat/SubagentDetailDialog.vue";
import SubagentProgressTree from "@/components/chat/SubagentProgressTree.vue";
import {
  type BackgroundTask,
  type BackgroundTaskStatus,
  formatTaskElapsed,
} from "@/features/journal/background-tasks.ts";

const props = defineProps<{
  /** Live, non-ambient tasks; empty hides the band. */
  tasks: BackgroundTask[];
}>();

// The elapsed label is the only live number here: the reducer is pure and the
// journal rebuilds the rest. The interval exists while the band is mounted and
// dies with it.
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  ticker = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});

onBeforeUnmount(() => {
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
});

const expanded = ref(false);
const selectedTask = ref<BackgroundTask | null>(null);
const detailOpen = ref(false);

function onSelectTask(task: BackgroundTask): void {
  selectedTask.value = task;
  detailOpen.value = true;
}

function elapsedFor(task: BackgroundTask): string {
  const started = Date.parse(task.startedAt);
  return Number.isNaN(started) ? "" : formatTaskElapsed(now.value - started);
}

function labelFor(task: BackgroundTask): string {
  return task.description || task.subagentType || task.workflowName || task.taskType || task.taskId;
}

function dotClass(status: BackgroundTaskStatus): string {
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

function statusLabel(status: BackgroundTaskStatus): string | undefined {
  switch (status) {
    case "running":
      return undefined;
    case "completed":
      return "đã xong";
    case "failed":
      return "lỗi";
    case "stopped":
      return "đã dừng";
  }
}

const oldestElapsed = computed(() => {
  const oldest = props.tasks.reduce<BackgroundTask | undefined>((held, task) => {
    if (held === undefined) return task;
    return Date.parse(task.startedAt) < Date.parse(held.startedAt) ? task : held;
  }, undefined);
  return oldest === undefined ? "" : elapsedFor(oldest);
});
</script>

<template>
  <div class="border-l-2 border-primary/50 bg-primary/5 px-3.5 py-2.5 text-[13px]">
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-2 text-left"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <i class="size-[7px] shrink-0 animate-pulse rounded-full bg-primary" aria-hidden="true" />
      <span class="font-medium text-foreground">{{ tasks.length }} task nền đang chạy</span>
      <span v-if="oldestElapsed" class="font-mono text-xs text-muted-foreground">
        · {{ oldestElapsed }}
      </span>
      <ChevronDown
        :size="14"
        class="ml-auto shrink-0 text-muted-foreground transition-transform"
        :class="expanded ? 'rotate-180' : ''"
        aria-hidden="true"
      />
    </button>

    <div v-if="expanded" class="mt-2 border-t border-primary/20 pt-2">
      <SubagentProgressTree :tasks="tasks" @select-task="onSelectTask" />
    </div>

    <SubagentDetailDialog v-model:open="detailOpen" :task="selectedTask" />
  </div>
</template>
