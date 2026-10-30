<script setup lang="ts">
import type { BrowserReplayEvent } from "@cc-web/protocol";
import { AlertCircle, Check, ChevronDown, ChevronRight, CircleStop, Loader2 } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { peekApprovalUi } from "@/features/approvals/store.ts";
import { approvalNeedsDecision } from "@/features/approvals/terminal.ts";
import type { AgentStep, AgentTurn } from "@/features/journal/chat-turns";
import {
  processBodyVisible,
  processSummaryLabel,
  summarizeProcessState,
} from "@/features/journal/chat-turns";
import ApprovalCard from "../ApprovalCard.vue";
import AgentThinkingStep from "./AgentThinkingStep.vue";
import AgentToolStep from "./AgentToolStep.vue";

/**
 * The collapsible process block for one agent turn (Claude.ai / ChatGPT style).
 *
 * Thinking and tool steps live inside the accordion: it starts open while the
 * turn runs, collapses to a one-line summary once it settles, and the operator
 * expands it to inspect the full timeline. Approval cards never hide inside it
 * — a pending decision is rendered outside the collapsible region, because an
 * answer the operator can't see is a run that hangs.
 */

const props = defineProps<{
  steps: AgentStep[];
  status: AgentTurn["status"];
  durationText?: string;
  terminalFor?: (
    event: BrowserReplayEvent,
  ) => { decision?: "allow" | "deny"; reason?: string } | undefined;
}>();

const summary = computed(() => summarizeProcessState(props.steps, props.status));
const executionSteps = computed(() => props.steps.filter((step) => step.kind !== "approval"));
type ApprovalStep = Extract<AgentStep, { kind: "approval" }>;
const approvalSteps = computed<ApprovalStep[]>(() =>
  props.steps.filter((step): step is ApprovalStep => step.kind === "approval"),
);

function terminalOf(step: ApprovalStep) {
  return props.terminalFor?.(step.event);
}

/**
 * Whether this card still needs a human — the same rule the card itself
 * applies (§13.2). A gate can go read-only before its journal terminal lands
 * (the route answered "expired", or its window passed), and the accordion must
 * not keep advertising "Đang chờ phê duyệt…" for a card nobody can answer.
 */
function needsDecision(step: ApprovalStep): boolean {
  const payload = (step.event.payload ?? {}) as Record<string, unknown>;
  const approvalId = typeof payload["approvalId"] === "string" ? payload["approvalId"] : "";
  return approvalNeedsDecision({
    terminal: terminalOf(step),
    expiresAt: typeof payload["expiresAt"] === "number" ? payload["expiresAt"] : undefined,
    closed: approvalId !== "" && peekApprovalUi(approvalId)?.closed === true,
  });
}

const closedApprovals = computed(() => approvalSteps.value.filter((step) => !needsDecision(step)));
const pendingApprovals = computed(() => approvalSteps.value.filter((step) => needsDecision(step)));

/** Open while running or failed; collapsed once the run settles. */
const isOpen = ref(props.status === "running" || props.status === "error");

watch(
  () => props.status,
  (next, prev) => {
    if (next === "running" || next === "error") isOpen.value = true;
    else if (prev === "running") isOpen.value = false;
  },
);

const summaryLabel = computed(() =>
  processSummaryLabel(props.status, summary.value, pendingApprovals.value.length),
);
</script>

<template>
  <div v-if="steps.length > 0" class="flex min-w-0 max-w-full flex-col gap-1.5 my-1">
    <button
      v-if="executionSteps.length > 0"
      type="button"
      :aria-expanded="isOpen"
      @click="isOpen = !isOpen"
      class="flex min-w-0 max-w-full items-center gap-1.5 text-xs transition-colors"
      :class="
        status === 'running'
          ? 'text-foreground'
          : summary.hasError
            ? 'text-destructive'
            : 'text-muted-foreground hover:text-foreground'
      "
    >
      <Loader2 v-if="status === 'running'" :size="13" class="shrink-0 animate-spin" />
      <AlertCircle v-else-if="summary.hasError" :size="13" class="shrink-0" />
      <CircleStop v-else-if="status === 'interrupted'" :size="13" class="shrink-0" />
      <Check v-else :size="13" class="shrink-0" />
      <span class="min-w-0 truncate">{{ summaryLabel }}</span>
      <span v-if="durationText" class="shrink-0 text-muted-foreground/70"
        >· {{ durationText }}</span
      >
      <ChevronDown v-if="isOpen" :size="12" class="shrink-0" />
      <ChevronRight v-else :size="12" class="shrink-0" />
    </button>

    <!--
      grid-template-rows 0fr→1fr animates the real content height, so a very
      long turn does not jump when its max-height cap would have clipped it.
    -->
    <transition
      enter-active-class="transition-all duration-150 ease-out"
      enter-from-class="opacity-0 [grid-template-rows:0fr]"
      enter-to-class="opacity-100 [grid-template-rows:1fr]"
      leave-active-class="transition-all duration-100 ease-in"
      leave-from-class="opacity-100 [grid-template-rows:1fr]"
      leave-to-class="opacity-0 [grid-template-rows:0fr]"
    >
      <div
        v-if="processBodyVisible(isOpen, executionSteps.length)"
        class="grid min-w-0 max-w-full"
      >
        <div class="min-h-0 min-w-0 overflow-hidden">
          <div
            class="flex min-w-0 max-w-full flex-col gap-1.5 border-l-2 border-border/60 pl-3 pb-1"
          >
            <template v-for="step in executionSteps" :key="step.key">
              <AgentThinkingStep v-if="step.kind === 'thinking'" :step="step" />
              <AgentToolStep v-else-if="step.kind === 'tool'" :step="step" />
            </template>
            <ApprovalCard
              v-for="step in closedApprovals"
              :key="step.key"
              :event="step.event"
              :terminal="terminalOf(step)"
            />
          </div>
        </div>
      </div>
    </transition>

    <!-- A pending decision is never collapsible: it stays visible until answered. -->
    <ApprovalCard
      v-for="step in pendingApprovals"
      :key="step.key"
      :event="step.event"
      :terminal="undefined"
    />
  </div>
</template>
