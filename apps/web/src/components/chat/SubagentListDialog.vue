<script setup lang="ts">
import {
  AlertCircle,
  Bot,
  Brain,
  Check,
  CircleStop,
  FileEdit,
  FilePlus,
  FileText,
  Loader2,
  MessageSquare,
  Search,
  Terminal,
  Wrench,
} from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatTaskElapsed } from "@/features/journal/background-tasks.ts";
import { type ToolStep, toolStepLabel } from "@/features/journal/chat-turns.ts";
import {
  resolveSelectedSubagentId,
  type SubagentItem,
  type SubagentStatus,
  summarizeSubagentCounts,
} from "@/features/journal/subagent-events.ts";
import { useI18n } from "@/lib/i18n";

const props = defineProps<{
  open: boolean;
  subagents: SubagentItem[];
  selectedId?: string | null;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  "update:selectedId": [value: string | null];
}>();

const { t, locale } = useI18n();

const internalSelectedId = ref<string | null>(props.selectedId ?? null);

watch(
  () => props.selectedId,
  (next) => {
    if (next !== undefined) {
      internalSelectedId.value = next;
    }
  },
);

const resolvedSelectedId = computed(() =>
  resolveSelectedSubagentId(props.subagents, internalSelectedId.value),
);

const activeSubagent = computed<SubagentItem | null>(() => {
  const target = resolvedSelectedId.value;
  if (target === null) return null;
  return props.subagents.find((item) => item.id === target) ?? props.subagents[0] ?? null;
});

function selectSubagent(id: string): void {
  internalSelectedId.value = id;
  emit("update:selectedId", id);
}

const counts = computed(() => summarizeSubagentCounts(props.subagents));

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

function elapsedFor(item: SubagentItem): string {
  if (item.usage?.durationMs !== undefined && item.status !== "running") {
    return formatTaskElapsed(item.usage.durationMs);
  }
  if (!item.startedAt) return "";
  const started = Date.parse(item.startedAt);
  if (Number.isNaN(started)) return "";
  const end =
    item.status === "running"
      ? now.value
      : item.updatedAt && !Number.isNaN(Date.parse(item.updatedAt))
        ? Date.parse(item.updatedAt)
        : now.value;
  return formatTaskElapsed(Math.max(0, end - started));
}

function statusText(status: SubagentStatus): string {
  switch (status) {
    case "running":
      return t("subagentTree.statusRunning");
    case "completed":
      return t("subagentTree.statusCompleted");
    case "failed":
      return t("subagentTree.statusFailed");
    case "stopped":
      return t("subagentTree.statusStopped");
  }
}

function statusBadgeClass(status: SubagentStatus): string {
  switch (status) {
    case "running":
      return "border-primary/30 bg-primary/10 text-primary";
    case "completed":
      return "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    case "failed":
      return "border-destructive/25 bg-destructive/10 text-destructive";
    case "stopped":
      return "border-border bg-muted text-muted-foreground";
  }
}

function toolIcon(toolName: string): unknown {
  const name = toolName.toLowerCase();
  if (name === "bash" || name === "terminal") return Terminal;
  if (name === "edit" || name === "notebookedit") return FileEdit;
  if (name === "write") return FilePlus;
  if (name === "read") return FileText;
  if (["grep", "glob", "explore", "websearch", "toolsearch"].includes(name)) return Search;
  if (name === "agent" || name === "task") return Bot;
  return Wrench;
}

function formatStepHeadline(step: ToolStep): string {
  // Touch locale.value so Vue tracks locale switches reactively.
  void locale.value;
  return toolStepLabel(step);
}
</script>

<template>
  <Dialog :open="props.open" @update:open="(v: boolean) => emit('update:open', v)">
    <DialogContent
      class="max-h-[85dvh] gap-0 overflow-hidden rounded-xl border border-border bg-card p-0 sm:max-w-4xl"
    >
      <DialogHeader class="border-b border-border/80 bg-muted/30 px-4 py-3.5 pr-12 text-left">
        <DialogTitle class="flex items-center gap-2 text-sm font-semibold text-foreground">
          <i
            v-if="counts.running > 0"
            class="size-2 shrink-0 animate-pulse rounded-full bg-primary"
            aria-hidden="true"
          />
          <Bot v-else :size="15" class="shrink-0 text-muted-foreground" />
          <span>{{ t("subagentTree.dialogTitle") }} ({{ subagents.length }})</span>
        </DialogTitle>
        <DialogDescription class="text-xs text-muted-foreground">
          {{ t("subagentTree.dialogSubtitle", { count: subagents.length }) }}
        </DialogDescription>
      </DialogHeader>

      <div
        v-if="subagents.length === 0"
        class="flex min-h-60 items-center justify-center p-6 text-xs text-muted-foreground"
      >
        {{ t("subagentTree.noData") }}
      </div>

      <div
        v-else
        class="grid max-h-[calc(85dvh-4.25rem)] min-h-[420px] grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)]"
      >
        <!-- Left column: Subagent list -->
        <div
          class="flex flex-col gap-1.5 overflow-y-auto border-b border-border/80 bg-muted/20 p-2.5 max-md:max-h-48 md:border-r md:border-b-0"
          role="listbox"
          :aria-label="t('subagentTree.dialogTitle')"
        >
          <button
            v-for="item in subagents"
            :key="item.id"
            type="button"
            role="option"
            :aria-selected="activeSubagent?.id === item.id"
            class="flex w-full cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors"
            :class="
              activeSubagent?.id === item.id
                ? 'border-border bg-card shadow-2xs'
                : 'border-transparent hover:bg-muted/60'
            "
            @click="selectSubagent(item.id)"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="truncate text-xs font-semibold text-foreground" :title="item.description">
                {{ item.description }}
              </span>
              <i
                v-if="item.status === 'running'"
                class="size-2 shrink-0 animate-pulse rounded-full bg-primary"
                :title="t('subagentTree.statusRunning')"
              />
              <Check
                v-else-if="item.status === 'completed'"
                :size="13"
                class="shrink-0 text-emerald-600 dark:text-emerald-400"
                :title="t('subagentTree.statusCompleted')"
              />
              <AlertCircle
                v-else-if="item.status === 'failed'"
                :size="13"
                class="shrink-0 text-destructive"
                :title="t('subagentTree.statusFailed')"
              />
              <CircleStop
                v-else
                :size="13"
                class="shrink-0 text-muted-foreground"
                :title="t('subagentTree.statusStopped')"
              />
            </div>

            <div class="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              <span
                v-if="item.subagentType || item.workflowName"
                class="rounded border border-border/80 bg-muted/60 px-1.5 py-0.25 text-[10px] text-foreground/80"
              >
                {{ item.subagentType || item.workflowName }}
              </span>
              <span>{{ t("subagentTree.eventsCount", { count: item.events.length }) }}</span>
              <span v-if="elapsedFor(item)">· {{ elapsedFor(item) }}</span>
            </div>
          </button>
        </div>

        <!-- Right column: Selected subagent event stream -->
        <div v-if="activeSubagent" class="flex min-h-0 min-w-0 flex-col overflow-hidden bg-card">
          <!-- Selected subagent header -->
          <div
            class="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 bg-muted/10 px-4 py-3"
          >
            <div class="min-w-0 flex-1">
              <div class="truncate text-[13px] font-semibold text-foreground" :title="activeSubagent.description">
                {{ activeSubagent.description }}
              </div>
              <div
                class="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[11px] text-muted-foreground"
              >
                <span class="truncate">{{ activeSubagent.taskId ?? activeSubagent.toolUseId ?? activeSubagent.id }}</span>
                <span v-if="activeSubagent.subagentType">
                  · {{ activeSubagent.subagentType }}
                </span>
                <span v-if="activeSubagent.usage">
                  · {{ activeSubagent.usage.totalTokens.toLocaleString() }} {{ t("subagentTree.tokens") }}
                  · {{ activeSubagent.usage.toolUses }} {{ t("subagentTree.toolUses") }}
                </span>
              </div>
            </div>

            <span
              class="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium"
              :class="statusBadgeClass(activeSubagent.status)"
            >
              <Loader2 v-if="activeSubagent.status === 'running'" :size="11" class="animate-spin" />
              <Check v-else-if="activeSubagent.status === 'completed'" :size="11" />
              <AlertCircle v-else-if="activeSubagent.status === 'failed'" :size="11" />
              <CircleStop v-else :size="11" />
              <span>{{ statusText(activeSubagent.status) }}</span>
              <span v-if="elapsedFor(activeSubagent)" class="font-mono">
                ({{ elapsedFor(activeSubagent) }})
              </span>
            </span>
          </div>

          <!-- Event list -->
          <div class="flex-1 space-y-2 overflow-y-auto p-4">
            <div
              v-if="activeSubagent.events.length === 0 && !activeSubagent.summary"
              class="flex h-40 items-center justify-center text-xs text-muted-foreground"
            >
              {{ t("subagentTree.eventsEmpty") }}
            </div>

            <template v-for="ev in activeSubagent.events" :key="ev.key">
              <!-- Tool step event -->
              <div
                v-if="ev.kind === 'tool'"
                class="rounded-lg border px-3 py-2 text-xs transition-colors"
                :class="
                  ev.step.state === 'running'
                    ? 'border-primary/35 bg-primary/5'
                    : 'border-border/70 bg-muted/25'
                "
              >
                <div class="flex items-center justify-between gap-2">
                  <div class="flex min-w-0 flex-1 items-center gap-1.5">
                    <component
                      :is="toolIcon(ev.step.toolName)"
                      :size="13"
                      class="shrink-0 text-muted-foreground"
                    />
                    <span
                      class="truncate font-mono text-[11.5px] text-foreground"
                      :title="formatStepHeadline(ev.step)"
                    >
                      {{ formatStepHeadline(ev.step) }}
                    </span>

                    <template v-if="ev.step.diffStats">
                      <span
                        v-if="ev.step.diffStats.added > 0"
                        class="inline-flex shrink-0 items-center font-mono text-[10.5px] text-emerald-600 dark:text-emerald-400"
                      >
                        +{{ ev.step.diffStats.added }}
                      </span>
                      <span
                        v-if="ev.step.diffStats.removed > 0"
                        class="inline-flex shrink-0 items-center font-mono text-[10.5px] text-rose-600 dark:text-rose-400"
                      >
                        -{{ ev.step.diffStats.removed }}
                      </span>
                    </template>
                  </div>

                  <span
                    v-if="ev.step.state === 'running'"
                    class="inline-flex shrink-0 items-center gap-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.25 text-[10px] font-medium text-primary"
                  >
                    <Loader2 :size="10" class="animate-spin" />
                    <span>{{ t("chat.running") }}</span>
                  </span>
                  <span
                    v-else-if="ev.step.state === 'error'"
                    class="inline-flex shrink-0 items-center gap-1 rounded border border-destructive/25 bg-destructive/10 px-1.5 py-0.25 text-[10px] font-medium text-destructive"
                  >
                    <AlertCircle :size="10" />
                    <span>{{ t("chat.failed") }}</span>
                  </span>
                  <span
                    v-else-if="ev.step.state === 'done'"
                    class="inline-flex shrink-0 items-center gap-0.5 rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.25 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
                  >
                    <Check :size="10" />
                  </span>
                </div>

                <pre
                  v-if="ev.step.outputSummary"
                  class="mt-1.5 max-h-36 overflow-auto rounded bg-background/80 px-2.5 py-1.5 font-mono text-[11px] whitespace-pre-wrap break-all text-muted-foreground"
                >{{ ev.step.outputSummary }}</pre>
              </div>

              <!-- Thinking event -->
              <div
                v-else-if="ev.kind === 'thinking'"
                class="rounded-lg border border-border/50 bg-muted/15 px-3 py-2 text-xs text-muted-foreground"
              >
                <div class="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-foreground/70">
                  <Brain :size="12" class="shrink-0" />
                  <span>{{ t("chat.thinking") }}</span>
                </div>
                <p class="whitespace-pre-wrap break-words text-[11.5px] italic">{{ ev.text }}</p>
              </div>

              <!-- Prose / message text event -->
              <div
                v-else-if="ev.kind === 'text'"
                class="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-foreground"
              >
                <div class="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <MessageSquare :size="12" class="shrink-0" />
                  <span>{{ t("chat.agent") }}</span>
                </div>
                <p class="whitespace-pre-wrap break-words leading-relaxed">{{ ev.text }}</p>
              </div>
            </template>

            <!-- Final summary block -->
            <div
              v-if="activeSubagent.summary"
              class="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3.5 py-2.5 text-xs"
            >
              <div class="mb-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                {{ t("subagentTree.summaryLabel") }}
              </div>
              <div class="whitespace-pre-wrap break-words leading-relaxed text-foreground/90">
                {{ activeSubagent.summary }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
