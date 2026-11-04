<script setup lang="ts">
import type { BrowserReplayEvent } from "@cc-web/protocol";
import { AlertCircle, Braces, Clock, Copy } from "@lucide/vue";
import { computed, ref } from "vue";
import { toast } from "vue-sonner";
import { peekApprovalUi } from "@/features/approvals/store.ts";
import { approvalNeedsDecision } from "@/features/approvals/terminal.ts";
import type { BackgroundTask } from "@/features/journal/background-tasks.ts";
import type { AgentStep, AgentTurn } from "@/features/journal/chat-turns";
import { proseClasses, renderMarkdown } from "@/features/journal/markdown";
import { useI18n } from "@/lib/i18n";
import AgentLiveStatus from "./AgentLiveStatus.vue";
import AgentProcessAccordion from "./AgentProcessAccordion.vue";

const { t } = useI18n();

const props = defineProps<{
  /** The agent turn to render. */
  turn: AgentTurn;
  /** Optional terminal resolver for approval steps. */
  terminalFor?: (
    event: BrowserReplayEvent,
  ) => { decision?: "allow" | "deny"; reason?: string } | undefined;
  /** Optional background-task lookup for the spawning tool step (P2b). */
  taskFor?: ((toolCallId: string) => BackgroundTask | undefined) | undefined;
}>();

const emit = defineEmits<{
  inspectSubagent: [subagentId: string];
}>();

/** Whether the raw payload panel is open. */
const showRaw = ref(false);

type SegmentRow =
  | { key: string; kind: "process"; steps: AgentStep[]; text: ""; isLastProcess: boolean }
  | { key: string; kind: "text"; steps: AgentStep[]; text: string; isLastProcess: false };

/**
 * Render rows for the interleaved segments, computed once per dependency
 * change: process rows carry only the steps the accordion shows (in-flight
 * tools stay with AgentLiveStatus), text rows their prose. The trailing
 * process frame is the active one and every earlier frame renders collapsed.
 */
const segmentRows = computed<SegmentRow[]>(() => {
  const segments = props.turn.segments ?? [];
  let lastProcessIdx = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]?.kind === "process") {
      lastProcessIdx = i;
      break;
    }
  }
  return segments.map((seg, idx) => {
    if (seg.kind === "text") {
      return {
        key: seg.key,
        kind: "text" as const,
        steps: [],
        text: seg.text,
        isLastProcess: false as const,
      };
    }
    const steps =
      props.turn.status === "running"
        ? seg.steps.filter((step) => step.kind !== "tool" || step.state !== "running")
        : seg.steps;
    return {
      key: seg.key,
      kind: "process" as const,
      steps,
      text: "" as const,
      isLastProcess: idx === lastProcessIdx,
    };
  });
});

/** Number of process frames that render their own accordion. */
const processFrameCount = computed(
  () => segmentRows.value.filter((row) => row.kind === "process" && row.steps.length > 0).length,
);

/**
 * A turn with exactly one process frame carries the run's duration in that
 * frame's summary row. With several frames that total would read as the last
 * frame's own duration, so it moves to the header instead.
 */
const segmentDurationText = computed(() =>
  processFrameCount.value === 1 ? props.turn.durationText : undefined,
);

/**
 * The header shows the duration unless a single process frame carries it.
 * Legacy turns without segments keep the old rule: any execution step means
 * the accordion shows it.
 */
const headerDuration = computed(() => {
  const hasExecutionSteps = props.turn.steps?.some((step) => step.kind !== "approval") ?? false;
  if (!hasExecutionSteps) return props.turn.durationText;
  const segmented = (props.turn.segments?.length ?? 0) > 0;
  return segmented && processFrameCount.value !== 1 ? props.turn.durationText : undefined;
});

/**
 * While a turn is running, any in-flight tool step is highlighted by AgentLiveStatus
 * at the tail. The accordion holds the completed/settled steps so the user
 * can inspect past execution without duplicate spinners.
 */
const completedSteps = computed(() => {
  if (props.turn.status !== "running") return props.turn.steps ?? [];
  return (props.turn.steps ?? []).filter(
    (step) => step.kind !== "tool" || step.state !== "running",
  );
});

/** Number of pending approvals that require operator decision. */
const pendingApprovalCount = computed(() => {
  return (props.turn.steps ?? []).filter((step) => {
    if (step.kind !== "approval") return false;
    const payload = (step.event.payload ?? {}) as Record<string, unknown>;
    const approvalId = typeof payload["approvalId"] === "string" ? payload["approvalId"] : "";
    return approvalNeedsDecision({
      terminal: props.terminalFor?.(step.event),
      expiresAt: typeof payload["expiresAt"] === "number" ? payload["expiresAt"] : undefined,
      closed: approvalId !== "" && peekApprovalUi(approvalId)?.closed === true,
    });
  }).length;
});

/**
 * Shows the live CLI status while the turn is running:
 * - Always when prose text has not arrived yet (thinking, running tools, waiting for model).
 * - When a tool step is currently executing even if preliminary text was streamed.
 */
const shouldShowLiveStatus = computed(() => {
  if (props.turn.status !== "running") return false;
  const hasRunningTool = (props.turn.steps ?? []).some(
    (s) => s.kind === "tool" && s.state === "running",
  );
  return props.turn.text.trim() === "" || hasRunningTool;
});

/** Copy the assistant response prose to the clipboard. */
async function copyResponse(): Promise<void> {
  if (!props.turn.text) return;
  await navigator.clipboard.writeText(props.turn.text);
  toast.success(t("chat.copiedAnswer"));
}

/** Copy the raw payload JSON to the clipboard with a toast. */
async function copyRawPayload(): Promise<void> {
  const text = JSON.stringify(props.turn.rawPayload, null, 2);
  await navigator.clipboard.writeText(text);
  toast.success(t("chat.copiedJson"));
}

/** The formatted JSON string for display. */
const rawJson = computed(() => JSON.stringify(props.turn.rawPayload, null, 2));
</script>

<template>
  <div class="group flex flex-col gap-2.5 w-full min-w-0 max-w-full text-foreground">
    <!-- Turn Header -->
    <div class="flex items-center gap-2 text-sm min-w-0">
      <div
        v-if="turn.status === 'error'"
        class="flex items-center gap-1.5 text-destructive shrink-0"
      >
        <AlertCircle :size="14" />
        <span>{{ t("chat.error") }}</span>
        <span v-if="headerDuration" class="text-muted-foreground">{{ headerDuration }}</span>
      </div>

      <div v-else-if="turn.status === 'interrupted'" class="flex items-center gap-1.5 shrink-0">
        <span>{{ t("chat.stopped") }}</span>
        <span v-if="headerDuration" class="text-muted-foreground">{{ headerDuration }}</span>
      </div>

      <div v-else class="flex items-center gap-1.5 shrink-0 text-muted-foreground">
        <Clock :size="14" />
        <span>{{ turn.status === 'done' && headerDuration ? t('chat.processedIn', { duration: headerDuration }) : t('chat.agent') }}</span>
      </div>

      <!-- Horizontal divider line filling remaining width -->
      <span class="h-px flex-1 bg-border/60" aria-hidden="true" />
    </div>

    <!-- Interleaved Segments (Process frames and Prose text in chronological order) -->
    <template v-if="segmentRows.length > 0">
      <template v-for="row in segmentRows" :key="row.key">
        <AgentProcessAccordion
          v-if="row.kind === 'process' && row.steps.length > 0"
          :steps="row.steps"
          :status="row.isLastProcess ? turn.status : 'done'"
          :duration-text="row.isLastProcess ? segmentDurationText : undefined"
          :terminal-for="terminalFor"
          :task-for="taskFor"
          @inspect-subagent="(id) => emit('inspectSubagent', id)"
        />

        <div
          v-else-if="row.kind === 'text' && row.text"
          :class="proseClasses"
          class="min-w-0 max-w-full break-words"
          v-html="renderMarkdown(row.text)"
        />
      </template>
    </template>

    <!-- Legacy fallback when turn has no segments array -->
    <template v-else>
      <AgentProcessAccordion
        v-if="completedSteps.length > 0"
        :steps="completedSteps"
        :status="turn.status"
        :duration-text="turn.durationText"
        :terminal-for="terminalFor"
        :task-for="taskFor"
        @inspect-subagent="(id) => emit('inspectSubagent', id)"
      />

      <div
        v-if="turn.text"
        :class="proseClasses"
        class="min-w-0 max-w-full break-words"
        v-html="renderMarkdown(turn.text)"
      />
    </template>

    <!-- Unified CLI-style live status while turn is running -->
    <AgentLiveStatus
      v-if="shouldShowLiveStatus"
      :turn="turn"
      :steps="turn.steps ?? []"
      :pending-approval-count="pendingApprovalCount"
    />

    <!-- Actions row (Copy response, Raw JSON toggle) - icon only, visible on hover -->
    <div
      class="mt-1 flex items-center gap-1 transition-opacity"
      :class="showRaw ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 max-sm:opacity-100'"
    >
      <button
        v-if="turn.text"
        type="button"
        @click="copyResponse"
        :title="t('chat.copyAnswer')"
        class="flex size-9 items-center justify-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors sm:size-6"
      >
        <Copy :size="13" />
      </button>
      <button
        v-if="turn.rawPayload !== undefined"
        type="button"
        :aria-expanded="showRaw"
        @click="showRaw = !showRaw"
        :title="showRaw ? t('chat.hideRaw') : t('chat.showRaw')"
        class="flex size-9 items-center justify-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors sm:size-6"
        :class="{ 'text-foreground bg-muted/60': showRaw }"
      >
        <Braces :size="13" />
      </button>
    </div>

    <!-- Raw Payload Viewer -->
    <transition
      enter-active-class="transition-all duration-150 ease-out"
      enter-from-class="opacity-0 max-h-0"
      enter-to-class="opacity-100 max-h-80"
      leave-active-class="transition-all duration-100 ease-in"
      leave-from-class="opacity-100 max-h-80"
      leave-to-class="opacity-0 max-h-0"
    >
      <div v-if="showRaw && turn.rawPayload !== undefined" class="overflow-hidden">
        <pre
          class="mt-1 max-h-80 overflow-auto rounded-md border border-border/60 bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-all text-muted-foreground"
        >{{ rawJson }}</pre>
        <button
          type="button"
          @click.stop="copyRawPayload"
          class="mt-1.5 flex min-h-9 items-center gap-1 rounded border border-border/40 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors sm:min-h-0 sm:px-2 sm:py-1"
        >
          <Copy :size="11" />
          <span>{{ t("chat.copyJson") }}</span>
        </button>
      </div>
    </transition>
  </div>
</template>
