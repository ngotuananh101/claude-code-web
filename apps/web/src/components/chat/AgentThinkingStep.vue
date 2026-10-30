<script setup lang="ts">
import { Braces, ChevronDown, ChevronRight } from "@lucide/vue";
import { ref } from "vue";
import type { ThinkingStep } from "@/features/journal/chat-turns";
import { formatDuration } from "@/features/journal/chat-turns";

const props = defineProps<{
  /** The thinking step to render. */
  step: ThinkingStep;
}>();

/** Collapsed by default. */
const isOpen = ref(false);

/** Human-readable duration suffix, e.g. "· 12m 50s". */
const durationText =
  props.step.durationMs !== undefined ? `· ${formatDuration(props.step.durationMs)}` : "";
</script>

<template>
  <div class="flex flex-col gap-1 min-w-0 max-w-full">
    <button
      type="button"
      :aria-expanded="isOpen"
      @click="isOpen = !isOpen"
      class="flex items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground min-w-0"
    >
      <Braces :size="13" />
      <span>Suy nghĩ</span>
      <span v-if="durationText" class="text-muted-foreground/70">{{ durationText }}</span>
      <ChevronRight v-if="!isOpen" :size="12" />
      <ChevronDown v-else :size="12" />
    </button>

    <transition
      enter-active-class="transition-all duration-150 ease-out"
      enter-from-class="opacity-0 max-h-0"
      enter-to-class="opacity-100 max-h-96"
      leave-active-class="transition-all duration-100 ease-in"
      leave-from-class="opacity-100 max-h-96"
      leave-to-class="opacity-0 max-h-0"
    >
      <div v-if="isOpen" class="overflow-hidden">
        <pre
          class="mt-1.5 rounded-md border border-border/60 bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap leading-relaxed text-muted-foreground select-text max-h-96 overflow-y-auto"
          >{{ step.text }}</pre
        >
      </div>
    </transition>
  </div>
</template>
