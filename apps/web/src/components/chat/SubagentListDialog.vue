<script setup lang="ts">
import type { BrowserReplayEvent } from "@cc-web/protocol";
import { AlertCircle, Bot, Check, CircleStop, History, Loader2 } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ApprovalTerminal } from "@/features/approvals/terminal.ts";
import { mapApprovalTerminals } from "@/features/approvals/terminal.ts";
import type { BackgroundTask, BackgroundTaskState } from "@/features/journal/background-tasks.ts";
import { formatTaskElapsed } from "@/features/journal/background-tasks.ts";
import {
  filterHistorySubagents,
  filterVisibleSubagents,
  resolveSelectedSubagentId,
  resolveSubagentDialogTab,
  type SubagentDialogTab,
  type SubagentItem,
  type SubagentStatus,
  summarizeSubagentCounts,
} from "@/features/journal/subagent-events.ts";
import { useI18n } from "@/lib/i18n";
import AgentChatTurn from "./AgentChatTurn.vue";
import UserChatBubble from "./UserChatBubble.vue";

const props = defineProps<{
  open: boolean;
  subagents: SubagentItem[];
  selectedId?: string | null;
  tab?: SubagentDialogTab;
  events?: BrowserReplayEvent[];
  backgroundTaskState?: BackgroundTaskState;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  "update:selectedId": [value: string | null];
  "update:tab": [value: SubagentDialogTab];
}>();

const { t } = useI18n();

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

const internalSelectedId = ref<string | null>(props.selectedId ?? null);
const internalTab = ref<SubagentDialogTab>(props.tab ?? "active");

watch(
  () => props.selectedId,
  (next) => {
    if (next !== undefined) {
      internalSelectedId.value = next;
    }
  },
);

watch(
  [() => props.open, () => props.tab, () => props.selectedId],
  ([open, requestedTab, requestedSelectedId]) => {
    if (!open && requestedTab !== undefined) {
      internalTab.value = requestedTab;
      return;
    }
    now.value = Date.now();
    const nextTab = resolveSubagentDialogTab(
      props.subagents,
      requestedTab ?? internalTab.value,
      requestedSelectedId ?? internalSelectedId.value,
      now.value,
    );
    internalTab.value = nextTab;
    emit("update:tab", nextTab);
  },
  { immediate: true },
);

watch(
  () => props.subagents,
  () => {
    now.value = Date.now();
  },
);

function setTab(nextTab: SubagentDialogTab): void {
  internalTab.value = nextTab;
  emit("update:tab", nextTab);
}

const visibleSubagents = computed(() => filterVisibleSubagents(props.subagents, now.value));
const historySubagents = computed(() => filterHistorySubagents(props.subagents));
const displayedSubagents = computed(() =>
  internalTab.value === "history" ? historySubagents.value : visibleSubagents.value,
);

const resolvedSelectedId = computed(() =>
  resolveSelectedSubagentId(displayedSubagents.value, internalSelectedId.value),
);

const activeSubagent = computed<SubagentItem | null>(() => {
  const target = resolvedSelectedId.value;
  if (target === null) return null;
  return (
    displayedSubagents.value.find((item) => item.id === target) ??
    displayedSubagents.value[0] ??
    null
  );
});

function selectSubagent(id: string): void {
  const targetTab = resolveSubagentDialogTab(props.subagents, internalTab.value, id, now.value);
  if (targetTab !== internalTab.value) {
    setTab(targetTab);
  }
  internalSelectedId.value = id;
  emit("update:selectedId", id);
}

const counts = computed(() => summarizeSubagentCounts(displayedSubagents.value));

const approvalTerminals = computed(() =>
  mapApprovalTerminals(
    (props.events ?? []).map((event) => ({ type: event.type, payload: event.payload })),
  ),
);

function terminalFor(event: BrowserReplayEvent): ApprovalTerminal | undefined {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const approvalId = payload["approvalId"];
  return typeof approvalId === "string" ? approvalTerminals.value.get(approvalId) : undefined;
}

const taskByToolCallId = computed(() => {
  const map = new Map<string, BackgroundTask>();
  for (const task of props.backgroundTaskState?.tasks.values() ?? []) {
    if (task.toolUseId !== undefined) map.set(task.toolUseId, task);
  }
  return map;
});

function taskFor(toolCallId: string): BackgroundTask | undefined {
  return taskByToolCallId.value.get(toolCallId);
}

function elapsedFor(item: SubagentItem): string {
  if (item.usage?.durationMs !== undefined && item.status !== "running") {
    return formatTaskElapsed(item.usage.durationMs);
  }
  if (!item.startedAt) return "";
  const started = Date.parse(item.startedAt);
  if (Number.isNaN(started)) return "";
  const endTimestamp = item.completedAt ?? item.updatedAt;
  const end =
    item.status === "running"
      ? now.value
      : endTimestamp && !Number.isNaN(Date.parse(endTimestamp))
        ? Date.parse(endTimestamp)
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
</script>

<template>
  <Dialog :open="props.open" @update:open="(v: boolean) => emit('update:open', v)">
    <DialogContent
      class="flex h-[min(85dvh,46rem)] max-h-[85dvh] flex-col gap-0 overflow-hidden rounded-xl border border-border bg-card p-0 sm:max-w-5xl"
    >
      <DialogHeader
        class="shrink-0 border-b border-border/80 bg-muted/30 px-4 py-3.5 pr-12 text-left"
      >
        <DialogTitle class="flex items-center gap-2 text-sm font-semibold text-foreground">
          <i
            v-if="counts.running > 0"
            class="size-2 shrink-0 animate-pulse rounded-full bg-primary"
            aria-hidden="true"
          />
          <Bot v-else :size="15" class="shrink-0 text-muted-foreground" />
          <span>{{ t("subagentTree.dialogTitle") }} ({{ displayedSubagents.length }})</span>
        </DialogTitle>
        <DialogDescription class="text-xs text-muted-foreground">
          {{ t("subagentTree.dialogSubtitle", { count: subagents.length }) }}
        </DialogDescription>
      </DialogHeader>

      <div
        v-if="subagents.length === 0"
        class="flex min-h-0 flex-1 items-center justify-center p-6 text-xs text-muted-foreground"
      >
        {{ t("subagentTree.noData") }}
      </div>

      <div
        v-else
        class="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden md:grid-cols-[280px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]"
      >
        <!-- Left column: Active / History tabs + Subagent list -->
        <div
          class="flex min-h-0 flex-col border-b border-border/80 bg-muted/20 max-md:max-h-56 md:h-full md:border-r md:border-b-0"
        >
          <div class="grid shrink-0 grid-cols-2 gap-1 border-b border-border/70 p-2">
            <button
              type="button"
              class="inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors"
              :class="
                internalTab === 'active'
                  ? 'bg-card text-foreground shadow-2xs ring-1 ring-border/80'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              "
              @click="setTab('active')"
            >
              <Bot :size="12" class="shrink-0" />
              <span class="truncate">{{
                t("subagentTree.activeTab", { count: visibleSubagents.length })
              }}</span>
            </button>
            <button
              type="button"
              class="inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors"
              :class="
                internalTab === 'history'
                  ? 'bg-card text-foreground shadow-2xs ring-1 ring-border/80'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              "
              @click="setTab('history')"
            >
              <History :size="12" class="shrink-0" />
              <span class="truncate">{{
                t("subagentTree.historyTab", { count: historySubagents.length })
              }}</span>
            </button>
          </div>

          <ScrollArea
            class="min-h-0 flex-1 max-md:[&>[data-slot=scroll-area-viewport]]:max-h-40 [&>[data-slot=scroll-area-viewport]]:overscroll-contain"
          >
            <div
              v-if="displayedSubagents.length === 0"
              class="flex flex-col items-center justify-center gap-2.5 px-4 py-8 text-center text-xs text-muted-foreground"
            >
              <span>{{
                internalTab === "active"
                  ? t("subagentTree.activeEmptyWithHistory")
                  : t("subagentTree.historyEmpty")
              }}</span>
              <Button
                v-if="internalTab === 'active' && historySubagents.length > 0"
                variant="outline"
                size="xs"
                class="gap-1.5"
                @click="setTab('history')"
              >
                <History :size="12" />
                <span>{{
                  t("subagentTree.openHistoryBtn", { count: historySubagents.length })
                }}</span>
              </Button>
            </div>

            <div
              v-else
              class="flex flex-col gap-1.5 p-2.5 pr-3"
              role="listbox"
              :aria-label="t('subagentTree.dialogTitle')"
            >
              <button
                v-for="item in displayedSubagents"
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
                  <span
                    class="truncate text-xs font-semibold text-foreground"
                    :title="item.description"
                  >
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

                <div
                  class="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
                >
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
          </ScrollArea>
        </div>

        <!-- Right column: Selected subagent event stream (same components as EventJournal.vue) -->
        <div
          v-if="activeSubagent"
          :key="activeSubagent.id"
          class="flex min-h-0 min-w-0 flex-col overflow-hidden bg-card"
        >
          <!-- Selected subagent header -->
          <div
            class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/70 bg-muted/10 px-4 py-3"
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

          <!-- Event stream rendered with UserChatBubble + AgentChatTurn like the main journal -->
          <ScrollArea
            class="min-h-0 min-w-0 flex-1 [&>[data-slot=scroll-area-viewport]]:overscroll-contain"
          >
            <div class="flex w-full min-w-0 flex-col gap-5 px-4 py-4 pr-5 md:px-5">
              <div
                v-if="activeSubagent.turns.length === 0"
                class="flex h-40 items-center justify-center text-xs text-muted-foreground"
              >
                {{ t("subagentTree.eventsEmpty") }}
              </div>

              <template v-else>
                <template v-for="turn in activeSubagent.turns" :key="turn.key">
                  <UserChatBubble v-if="turn.kind === 'user'" :turn="turn" />
                  <AgentChatTurn
                    v-else-if="turn.kind === 'agent'"
                    :turn="turn"
                    :default-process-open="true"
                    :terminal-for="terminalFor"
                    :task-for="taskFor"
                    @inspect-subagent="(id) => selectSubagent(id)"
                  />
                </template>
              </template>
            </div>
          </ScrollArea>
        </div>

        <div
          v-else
          class="flex min-h-0 min-w-0 flex-col items-center justify-center gap-3 bg-card p-6 text-center text-xs text-muted-foreground"
        >
          <span>{{
            internalTab === "active"
              ? t("subagentTree.activeEmptyWithHistory")
              : t("subagentTree.historyEmpty")
          }}</span>
          <Button
            v-if="internalTab === 'active' && historySubagents.length > 0"
            variant="outline"
            size="sm"
            class="gap-1.5"
            @click="setTab('history')"
          >
            <History :size="13" />
            <span>{{
              t("subagentTree.openHistoryBtn", { count: historySubagents.length })
            }}</span>
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
