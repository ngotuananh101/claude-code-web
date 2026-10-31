<script setup lang="ts">
import { Asterisk } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { AgentStep, AgentTurn } from "@/features/journal/chat-turns";
import { formatElapsedSeconds, resolveActiveStatus } from "@/features/journal/chat-turns";

const props = defineProps<{
  /** The parent agent turn. */
  turn: AgentTurn;
  /** Current steps in the turn. */
  steps: AgentStep[];
  /** Number of approvals waiting on operator decision. */
  pendingApprovalCount?: number;
}>();

const statusInfo = computed(() =>
  resolveActiveStatus(
    props.steps,
    props.turn.text.trim() !== "",
    props.turn.isStreaming ?? false,
    props.pendingApprovalCount ?? 0,
  ),
);

/** Action elapsed seconds timer (ticks every 500ms). */
const elapsedSeconds = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;
let actionStartTime = Date.now();

function resetTimer(): void {
  actionStartTime = Date.now();
  elapsedSeconds.value = 0;
}

// Reset timer whenever the active action or target detail changes.
watch(
  () => `${statusInfo.value.label}:${statusInfo.value.subDetail ?? ""}`,
  () => {
    resetTimer();
  },
);

onMounted(() => {
  resetTimer();
  timer = setInterval(() => {
    elapsedSeconds.value = Math.max(0, Math.floor((Date.now() - actionStartTime) / 1000));
  }, 500);
});

onBeforeUnmount(() => {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
});

const formattedElapsed = computed(() => formatElapsedSeconds(elapsedSeconds.value));
</script>

<template>
  <div class="my-1.5 flex flex-col gap-1 min-w-0 max-w-full">
    <!-- Main active status line (Claude Code CLI style) -->
    <div class="flex items-center gap-2 min-w-0 text-xs">
      <Asterisk :size="14" class="animate-spin text-primary shrink-0" />
      <span class="font-medium text-foreground truncate">{{ statusInfo.label }}</span>
      <span class="text-muted-foreground font-mono shrink-0">({{ formattedElapsed }})</span>
    </div>

    <!-- Tree branch sub-line for file path / command / input summary -->
    <div
      v-if="statusInfo.subDetail"
      class="flex items-center gap-1.5 pl-5 min-w-0 text-[11px] text-muted-foreground font-mono"
    >
      <span class="text-muted-foreground/60 select-none shrink-0">└─</span>
      <span class="truncate" :title="statusInfo.subDetail">{{ statusInfo.subDetail }}</span>
    </div>
  </div>
</template>
