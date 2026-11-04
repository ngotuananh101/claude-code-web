<script setup lang="ts">
import { computed } from "vue";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type BackgroundTask, formatTaskElapsed } from "@/features/journal/background-tasks.ts";
import { useI18n } from "@/lib/i18n";

const props = defineProps<{
  open: boolean;
  task: BackgroundTask | null;
}>();

const emit = defineEmits<(e: "update:open", value: boolean) => void>();

const { t } = useI18n();

function elapsedMs(task: BackgroundTask): number {
  const started = Date.parse(task.startedAt);
  const ended = Date.parse(task.updatedAt);
  if (Number.isNaN(started)) return 0;
  const end = Number.isNaN(ended) ? Date.now() : ended;
  return Math.max(0, end - started);
}

const elapsedLabel = computed(() => {
  if (props.task === null) return "";
  return formatTaskElapsed(elapsedMs(props.task));
});

function statusBadgeClass(status: BackgroundTask["status"]): string {
  switch (status) {
    case "running":
      return "bg-primary/10 text-primary";
    case "completed":
      return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    case "failed":
      return "bg-destructive/10 text-destructive";
    case "stopped":
      return "bg-muted text-muted-foreground";
  }
}
</script>

<template>
  <Dialog :open="props.open" @update:open="(v: boolean) => emit('update:open', v)">
    <DialogContent class="max-h-[85dvh] overflow-y-auto overscroll-contain sm:max-w-lg">
      <DialogHeader>
        <DialogTitle class="text-base">
          {{ props.task?.description || props.task?.taskId || t("subagentTree.title") }}
        </DialogTitle>
        <DialogDescription class="text-xs text-muted-foreground">
          {{ props.task?.taskId }}
        </DialogDescription>
      </DialogHeader>

      <div v-if="props.task" class="space-y-3 text-sm">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs text-muted-foreground">{{ t("subagentTree.status") }}</span>
          <span
            class="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium"
            :class="statusBadgeClass(props.task.status)"
          >
            {{ props.task.status }}
          </span>
          <span
            v-if="props.task.subagentType"
            class="inline-flex items-center rounded border border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
          >
            {{ props.task.subagentType }}
          </span>
          <span
            v-if="props.task.workflowName"
            class="inline-flex items-center rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
          >
            {{ props.task.workflowName }}
          </span>
        </div>

        <dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs [&_dd]:min-w-0">
          <dt class="text-muted-foreground">{{ t("subagentTree.taskId") }}</dt>
          <dd class="font-mono truncate">{{ props.task.taskId }}</dd>
          <dt v-if="props.task.parentTaskId" class="text-muted-foreground">{{ t("subagentTree.parentTask") }}</dt>
          <dd v-if="props.task.parentTaskId" class="font-mono truncate">{{ props.task.parentTaskId }}</dd>
          <dt class="text-muted-foreground">{{ t("subagentTree.started") }}</dt>
          <dd class="font-mono truncate">{{ props.task.startedAt }}</dd>
          <dt class="text-muted-foreground">{{ t("subagentTree.updated") }}</dt>
          <dd class="font-mono truncate">{{ props.task.updatedAt }}</dd>
          <dt class="text-muted-foreground">{{ t("subagentTree.elapsed") }}</dt>
          <dd class="font-mono">{{ elapsedLabel }}</dd>
          <dt v-if="props.task.lastToolName" class="text-muted-foreground">{{ t("subagentTree.lastTool") }}</dt>
          <dd v-if="props.task.lastToolName" class="font-mono truncate">{{ props.task.lastToolName }}</dd>
        </dl>

        <div v-if="props.task.usage" class="rounded-md border border-border/60 bg-muted/40 p-2.5">
          <div class="mb-1 text-xs font-semibold text-foreground/70">{{ t("subagentTree.usage") }}</div>
          <dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs [&_dd]:min-w-0">
            <dt class="text-muted-foreground">{{ t("subagentTree.tokens") }}</dt>
            <dd class="font-mono">{{ props.task.usage.totalTokens }}</dd>
            <dt class="text-muted-foreground">{{ t("subagentTree.toolUses") }}</dt>
            <dd class="font-mono">{{ props.task.usage.toolUses }}</dd>
            <dt class="text-muted-foreground">{{ t("subagentTree.duration") }}</dt>
            <dd class="font-mono">{{ formatTaskElapsed(props.task.usage.durationMs) }}</dd>
          </dl>
        </div>

        <p v-if="props.task.summary" class="text-xs text-muted-foreground">
          {{ props.task.summary }}
        </p>
      </div>
    </DialogContent>
  </Dialog>
</template>