<script setup lang="ts">
import { ChevronDown, ChevronRight } from "@lucide/vue";
import { ref } from "vue";
import { toast } from "vue-sonner";
import type { UserTurn } from "@/features/journal/chat-turns";
import { proseClasses, renderMarkdown } from "@/features/journal/markdown";

const props = defineProps<{
  /** The user turn to render. */
  turn: UserTurn;
}>();

/** Whether the raw payload panel is open. */
const showRaw = ref(false);

/** Copy the raw payload JSON to the clipboard. */
async function copyRawPayload(): Promise<void> {
  const text = JSON.stringify(props.turn.rawPayload, null, 2);
  await navigator.clipboard.writeText(text);
  toast.success("Đã sao chép payload thô.");
}
</script>

<template>
  <div class="flex w-full justify-end">
    <div
      class="group relative max-w-[85%] rounded-2xl bg-secondary/80 px-4 py-2.5 text-[13px] text-foreground shadow-xs"
    >
      <div v-html="renderMarkdown(turn.text)" :class="proseClasses" />

      <!-- Subtle hover toggle to view raw payload when present. -->
      <button
        v-if="turn.rawPayload !== undefined"
        type="button"
        :aria-expanded="showRaw"
        @click="showRaw = !showRaw"
        class="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover:opacity-60 hover:opacity-100"
        :title="showRaw ? 'Ẩn payload' : 'Xem payload thô'"
      >
        <ChevronDown v-if="showRaw" :size="12" />
        <ChevronRight v-else :size="12" />
      </button>

      <transition
        enter-active-class="transition-all duration-150 ease-out"
        enter-from-class="opacity-0 translate-y-1"
        enter-to-class="opacity-100 translate-y-0"
        leave-active-class="transition-all duration-100 ease-in"
        leave-from-class="opacity-100 translate-y-0"
        leave-to-class="opacity-0 translate-y-1"
      >
        <div
          v-if="showRaw"
          class="mt-2 max-h-60 w-full overflow-y-auto rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground"
        >
          <pre class="whitespace-pre-wrap break-all">{{ JSON.stringify(turn.rawPayload, null, 2) }}</pre>
          <button
            type="button"
            @click.stop="copyRawPayload"
            class="mt-1 flex items-center gap-1 rounded border border-border/40 px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            >Sao chép</button
          >
        </div>
      </transition>
    </div>
  </div>
</template>
