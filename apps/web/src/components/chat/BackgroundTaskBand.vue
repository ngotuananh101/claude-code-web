<script setup lang="ts">
import { ChevronDown } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
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

    <ul v-if="expanded" class="mt-2 space-y-1.5 border-t border-primary/20 pt-2">
      <li v-for="task in tasks" :key="task.taskId" class="min-w-0">
        <div class="flex min-w-0 items-baseline gap-2">
          <i
            class="size-[7px] shrink-0 rounded-full"
            :class="dotClass(task.status)"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 truncate" :title="labelFor(task)">{{ labelFor(task) }}</span>
          <span
            v-if="task.subagentType"
            class="shrink-0 rounded-sm border border-border px-1 font-mono text-[10px] text-muted-foreground"
          >
            {{ task.subagentType }}
          </span>
          <span v-if="statusLabel(task.status)" class="shrink-0 text-[11px] text-muted-foreground">
            {{ statusLabel(task.status) }}
          </span>
          <span v-if="task.lastToolName" class="shrink-0 font-mono text-[11px] text-muted-foreground">
            {{ task.lastToolName }}
          </span>
          <span class="shrink-0 font-mono text-[11px] text-muted-foreground">
            {{ elapsedFor(task) }}
          </span>
        </div>
        <p
          v-if="task.summary || task.usage"
          class="mt-0.5 truncate pl-4 text-[12px] text-muted-foreground"
        >
          {{ task.summary }}
          <span v-if="task.usage">
            · {{ task.usage.totalTokens }} tokens · {{ task.usage.toolUses }} tool
          </span>
        </p>
      </li>
    </ul>
  </div>
</template>
