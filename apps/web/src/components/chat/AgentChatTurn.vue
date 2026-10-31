<script setup lang="ts">
import type { BrowserReplayEvent } from "@cc-web/protocol";
import { AlertCircle, Braces, Clock, Copy } from "@lucide/vue";
import { computed, ref } from "vue";
import { toast } from "vue-sonner";
import { peekApprovalUi } from "@/features/approvals/store.ts";
import { approvalNeedsDecision } from "@/features/approvals/terminal.ts";
import type { AgentTurn } from "@/features/journal/chat-turns";
import { proseClasses, renderMarkdown } from "@/features/journal/markdown";
import AgentLiveStatus from "./AgentLiveStatus.vue";
import AgentProcessAccordion from "./AgentProcessAccordion.vue";

const props = defineProps<{
  /** The agent turn to render. */
  turn: AgentTurn;
  /** Optional terminal resolver for approval steps. */
  terminalFor?: (
    event: BrowserReplayEvent,
  ) => { decision?: "allow" | "deny"; reason?: string } | undefined;
}>();

/** Whether the raw payload panel is open. */
const showRaw = ref(false);

/**
 * The accordion's summary row already carries the duration once it has any
 * execution step to show, so the header omits it there instead of printing it
 * twice.
 */
const headerDuration = computed(() =>
  props.turn.steps?.some((step) => step.kind !== "approval") ? undefined : props.turn.durationText,
);

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
  toast.success("Đã sao chép câu trả lời.");
}

/** Copy the raw payload JSON to the clipboard with a toast. */
async function copyRawPayload(): Promise<void> {
  const text = JSON.stringify(props.turn.rawPayload, null, 2);
  await navigator.clipboard.writeText(text);
  toast.success("Đã sao chép JSON.");
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
        <span>Lỗi</span>
        <span v-if="headerDuration" class="text-muted-foreground">{{ headerDuration }}</span>
      </div>

      <div v-else-if="turn.status === 'interrupted'" class="flex items-center gap-1.5 shrink-0">
        <span>Bị dừng</span>
        <span v-if="headerDuration" class="text-muted-foreground">{{ headerDuration }}</span>
      </div>

      <div v-else class="flex items-center gap-1.5 shrink-0 text-muted-foreground">
        <Clock :size="14" />
        <span>{{ turn.status === 'done' && headerDuration ? `Đã xử lý trong ${headerDuration}` : "Agent" }}</span>
      </div>

      <!-- Horizontal divider line filling remaining width -->
      <span class="h-px flex-1 bg-border/60" aria-hidden="true" />
    </div>

    <!-- Process accordion: thinking and settled tool steps collapse into one summary row -->
    <AgentProcessAccordion
      v-if="completedSteps.length > 0"
      :steps="completedSteps"
      :status="turn.status"
      :duration-text="turn.durationText"
      :terminal-for="terminalFor"
    />

    <!-- Unified CLI-style live status while turn is running -->
    <AgentLiveStatus
      v-if="shouldShowLiveStatus"
      :turn="turn"
      :steps="turn.steps ?? []"
      :pending-approval-count="pendingApprovalCount"
    />

    <!-- Assistant Response Prose -->
    <div
      v-if="turn.text"
      :class="proseClasses"
      class="min-w-0 max-w-full break-words"
      v-html="renderMarkdown(turn.text)"
    />

    <!-- Actions row (Copy response, Raw JSON toggle) - icon only, visible on hover -->
    <div
      class="mt-1 flex items-center gap-1 transition-opacity"
      :class="showRaw ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
    >
      <button
        v-if="turn.text"
        type="button"
        @click="copyResponse"
        title="Sao chép câu trả lời"
        class="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
      >
        <Copy :size="13" />
      </button>
      <button
        v-if="turn.rawPayload !== undefined"
        type="button"
        :aria-expanded="showRaw"
        @click="showRaw = !showRaw"
        :title="showRaw ? 'Ẩn JSON gốc' : 'Xem JSON gốc'"
        class="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
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
          class="mt-1.5 flex items-center gap-1 rounded border border-border/40 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Copy :size="11" />
          <span>Sao chép JSON</span>
        </button>
      </div>
    </transition>
  </div>
</template>
