<script setup lang="ts">
import type { AttachmentInfo } from "@cc-web/protocol";
import { Braces, Copy, FileText, X } from "@lucide/vue";
import { computed, ref } from "vue";
import { toast } from "vue-sonner";
import type { UserTurn } from "@/features/journal/chat-turns";
import { proseClasses, renderMarkdown } from "@/features/journal/markdown";
import { attachmentUrl } from "../../services/attachments-api";

const props = defineProps<{
  /** The user turn to render. */
  turn: UserTurn;
}>();

/** Whether the raw payload panel is open. */
const showRaw = ref(false);
/** The image attachment currently shown in the lightbox, or null. */
const lightboxSrc = ref<string | null>(null);

/** Format a byte count into a human-readable KB/MB string. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Whether this turn has any attachments to render. */
const hasAttachments = computed(
  () => props.turn.attachments !== undefined && props.turn.attachments.length > 0,
);

/** The non-image attachments (documents, code, logs, etc.). */
const docAttachments = computed(() => {
  return (props.turn.attachments ?? []).filter(
    (att: AttachmentInfo) => !att.mimeType.startsWith("image/"),
  );
});

/** The image attachments (rendered as thumbnails). */
const imageAttachments = computed(() => {
  return (props.turn.attachments ?? []).filter((att: AttachmentInfo) =>
    att.mimeType.startsWith("image/"),
  );
});

/** Copy the user prompt text to the clipboard. */
async function copyText(): Promise<void> {
  if (!props.turn.text) return;
  await navigator.clipboard.writeText(props.turn.text);
  toast.success("Đã sao chép nội dung.");
}

/** Copy the raw payload JSON to the clipboard. */
async function copyRawPayload(): Promise<void> {
  const text = JSON.stringify(props.turn.rawPayload, null, 2);
  await navigator.clipboard.writeText(text);
  toast.success("Đã sao chép JSON.");
}

const rawJson = computed(() => JSON.stringify(props.turn.rawPayload, null, 2));
</script>

<template>
  <div class="group flex w-full flex-col items-end">
    <!-- Attachments row (above the bubble) -->
    <div v-if="hasAttachments" class="mb-1.5 flex flex-wrap gap-1.5">
      <!-- Image thumbnails with lightbox -->
      <template v-for="att in imageAttachments" :key="att.id">
        <img
          :src="attachmentUrl(att.id)"
          :alt="att.name"
          class="h-20 w-auto rounded-lg border object-cover cursor-pointer hover:opacity-90"
          @click="lightboxSrc = attachmentUrl(att.id)"
          loading="lazy"
        />
      </template>

      <!-- Document / code / log chips with download link -->
      <template v-for="att in docAttachments" :key="att.id">
        <a
          :href="attachmentUrl(att.id)"
          download
          target="_blank"
          class="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-muted px-2 text-xs text-foreground hover:bg-muted/80"
          :title="att.name"
        >
          <FileText :size="13" class="shrink-0 text-muted-foreground" />
          <span class="max-w-[140px] truncate" :title="att.name">{{ att.name }}</span>
          <span class="shrink-0 text-[10px] text-muted-foreground">{{ formatSize(att.size) }}</span>
        </a>
      </template>
    </div>

    <!-- Bubble -->
    <div
      class="max-w-[85%] rounded-2xl border border-border bg-secondary/80 px-4 py-2.5 text-[13px] text-foreground shadow-xs"
    >
      <div v-html="renderMarkdown(turn.text)" :class="proseClasses" />
    </div>

    <!-- Actions row (Copy prompt, View JSON) below bubble, right-aligned, hover-only -->
    <div
      class="mt-1 flex items-center justify-end gap-1 transition-opacity"
      :class="showRaw ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
    >
      <button
        v-if="turn.text"
        type="button"
        @click="copyText"
        title="Sao chép nội dung"
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

    <!-- Raw payload viewer -->
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
        class="mt-1.5 max-w-[85%] w-full overflow-hidden"
      >
        <pre
          class="max-h-60 overflow-auto rounded-md border border-border/60 bg-muted/40 p-2.5 font-mono text-[11px] whitespace-pre-wrap break-all text-muted-foreground"
        >{{ rawJson }}</pre>
        <button
          type="button"
          @click.stop="copyRawPayload"
          class="mt-1 flex items-center gap-1 rounded border border-border/40 px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Copy :size="11" />
          <span>Sao chép JSON</span>
        </button>
      </div>
    </transition>

    <!-- Image lightbox modal -->
    <teleport to="body">
      <transition
        appear
        enter-active-class="transition-opacity duration-200 ease-out"
        enter-from-class="opacity-0"
        enter-to-class="opacity-100"
        leave-active-class="transition-opacity duration-150 ease-in"
        leave-from-class="opacity-100"
        leave-to-class="opacity-0"
      >
        <div
          v-if="lightboxSrc"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          @click="lightboxSrc = null"
        >
          <button
            type="button"
            class="absolute top-4 right-4 rounded-full p-1 text-white/70 hover:text-white"
            aria-label="Đóng"
            @click.stop="lightboxSrc = null"
          >
            <X :size="20" />
          </button>
          <img
            :src="lightboxSrc"
            class="max-w-[90vw] max-h-[90vh] rounded-lg object-contain"
            @click.stop
          />
        </div>
      </transition>
    </teleport>
  </div>
</template>
