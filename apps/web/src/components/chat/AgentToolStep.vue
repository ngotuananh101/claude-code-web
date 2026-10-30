<script setup lang="ts">
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileEdit,
  FilePlus,
  FileText,
  Loader2,
  Search,
  Terminal,
  Wrench,
} from "@lucide/vue";
import { computed, ref } from "vue";
import { toast } from "vue-sonner";
import type { ToolStep } from "@/features/journal/chat-turns";

const props = defineProps<{
  /** The tool step to render. */
  step: ToolStep;
}>();

/** Collapsed by default. */
const isOpen = ref(false);

/** Pick the icon component for the tool name. */
function toolIcon(toolName: string): unknown {
  const name = toolName.toLowerCase();
  if (name === "bash" || name === "terminal") return Terminal;
  if (name === "edit") return FileEdit;
  if (name === "write") return FilePlus;
  if (name === "read") return FileText;
  if (["grep", "glob", "explore"].includes(name)) return Search;
  return Wrench;
}

/** Localized label for the tool when it operates on a file. */
const fileLabels: Record<string, string> = {
  Edit: "Sửa file",
  Write: "Ghi file",
  Read: "Đọc file",
};

/** Short, one-line label shown in the collapsed header. */
const toolLabel = computed(() => {
  if (props.step.command) {
    return props.step.command;
  }
  if (props.step.filePath) {
    const label = fileLabels[props.step.toolName] ?? props.step.toolName;
    return `${label}: ${props.step.filePath}`;
  }
  const base = props.step.inputSummary ?? props.step.toolName;
  return base.length > 60 ? `${base.slice(0, 60)}…` : base;
});

/** The icon component to render. */
const IconComponent = computed(() => toolIcon(props.step.toolName));

/** Copy a string to the clipboard with a toast. */
async function copyToClipboard(text: string, label: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  toast.success(`Đã sao chép ${label}.`);
}
</script>

<template>
  <div class="flex flex-col gap-1 min-w-0 max-w-full">
    <button
      type="button"
      :aria-expanded="isOpen"
      @click="isOpen = !isOpen"
      class="flex items-center justify-between w-full min-w-0 max-w-full rounded-md px-2 py-1.5 text-xs hover:bg-muted/50 transition-colors text-left"
    >
      <div class="flex items-center gap-1.5 min-w-0 flex-1 mr-2">
        <component :is="IconComponent" :size="13" class="text-muted-foreground shrink-0" />
        <span class="font-mono truncate" :title="toolLabel">{{ toolLabel }}</span>

        <!-- Diff stats for file-editing tools. -->
        <template v-if="step.diffStats">
          <span
            v-if="step.diffStats.added > 0"
            class="inline-flex shrink-0 items-center font-mono text-[11px] text-emerald-600 dark:text-emerald-400"
            title="+dòng thêm"
          >
            +{{ step.diffStats.added }}
          </span>
          <span
            v-if="step.diffStats.removed > 0"
            class="inline-flex shrink-0 items-center font-mono text-[11px] text-rose-600 dark:text-rose-400"
            title="-dòng xoá"
          >
            -{{ step.diffStats.removed }}
          </span>
        </template>
      </div>

      <div class="flex items-center gap-1.5 shrink-0">
        <!-- Status badge. -->
        <span
          v-if="step.state === 'running'"
          class="inline-flex items-center gap-1 rounded border border-border/40 bg-muted/30 px-1.5 py-0.25 text-[10px] font-medium text-muted-foreground"
          title="Đang chạy"
        >
          <Loader2 :size="10" class="animate-spin" />
          <span>Đang chạy</span>
        </span>
        <span
          v-else-if="step.state === 'error'"
          class="inline-flex items-center gap-1 rounded border border-destructive/20 bg-destructive/10 px-1.5 py-0.25 text-[10px] font-medium text-destructive"
          title="Thất bại"
        >
          <AlertCircle :size="10" />
          <span>[Thất bại]</span>
        </span>
        <span
          v-else-if="step.state === 'interrupted'"
          class="inline-flex items-center rounded border border-border/40 bg-muted/30 px-1.5 py-0.25 text-[10px] font-medium text-muted-foreground"
          title="Bị dừng"
        >
          Bị dừng
        </span>
        <span
          v-else-if="step.state === 'done'"
          class="inline-flex items-center gap-0.5 rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.25 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
          title="Hoàn thành"
        >
          <Check :size="10" />
        </span>

        <!-- Chevron toggle. -->
        <ChevronDown v-if="isOpen" :size="12" class="text-muted-foreground" />
        <ChevronRight v-else :size="12" class="text-muted-foreground" />
      </div>
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
        <div class="mt-1 space-y-2">
          <!-- Input summary. -->
          <div
            v-if="step.inputSummary"
            class="rounded-md border border-border/60 bg-muted/40 p-2.5 font-mono text-[11px] text-muted-foreground"
          >
            <div class="mb-1 flex items-center justify-between">
              <span class="font-semibold text-foreground/60">Đầu vào</span>
              <button
                type="button"
                @click.stop="copyToClipboard(step.inputSummary!, 'đầu vào')"
                class="inline-flex items-center gap-0.5 rounded border border-border/30 px-1 py-0.25 text-[10px] text-muted-foreground hover:text-foreground"
                title="Sao chép đầu vào"
              >
                <Copy :size="10" />
              </button>
            </div>
            <pre class="whitespace-pre-wrap break-all text-muted-foreground">{{ step.inputSummary }}</pre>
          </div>

          <!-- Output summary. -->
          <div
            v-if="step.outputSummary"
            class="rounded-md border border-border/60 bg-muted/40 p-2.5 font-mono text-[11px] text-muted-foreground"
          >
            <div class="mb-1 flex items-center justify-between">
              <span class="font-semibold text-foreground/60">Đầu ra</span>
              <button
                type="button"
                @click.stop="copyToClipboard(step.outputSummary!, 'đầu ra')"
                class="inline-flex items-center gap-0.5 rounded border border-border/30 px-1 py-0.25 text-[10px] text-muted-foreground hover:text-foreground"
                title="Sao chép đầu ra"
              >
                <Copy :size="10" />
              </button>
            </div>
            <pre class="whitespace-pre-wrap break-all text-muted-foreground">{{ step.outputSummary }}</pre>
          </div>

          <!-- Neither input nor output available. -->
          <div
            v-if="!step.inputSummary && !step.outputSummary"
            class="rounded-md border border-border/60 bg-muted/40 p-2.5 text-center font-mono text-[11px] text-muted-foreground"
          >
            Không có dữ liệu chi tiết.
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>
