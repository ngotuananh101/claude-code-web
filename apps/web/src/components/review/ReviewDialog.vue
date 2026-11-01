<script setup lang="ts">
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Columns2,
  FileText,
  Map as MapIcon,
  Maximize2,
  Minimize2,
  RotateCcw,
  Rows2,
  Save,
  X,
} from "@lucide/vue";
import { useElementSize, useMediaQuery } from "@vueuse/core";
import { computed, ref, watch } from "vue";
import { toast } from "vue-sonner";
import MonacoCodeEditor from "@/components/review/MonacoCodeEditor.vue";
import MonacoDiffEditor from "@/components/review/MonacoDiffEditor.vue";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { minimapVisible, resolveSideBySide } from "@/features/review/diff-layout";
import type { LineChangeSummary } from "@/features/review/diff-stats";
import {
  findNextPath,
  findPrevPath,
  formatFileCounter,
  nextPathAfterToggleReview,
} from "@/features/review/review-navigation";
import { cn } from "@/lib/utils";

const props = defineProps<{
  open: boolean;
  mode: "diff" | "file";
  path: string;
  allPaths: string[];
  original?: string;
  modified?: string;
  content?: string;
  isReviewed?: boolean;
  dirty?: boolean;
  isPathReviewed?: (path: string) => boolean;
  /** The file's change type in the visible Changes list ("sửa", "thêm", …). */
  statusLabel?: string;
  /** Save/revert failure surfaced by the parent; rendered in the footer. */
  error?: string | null;
  /** The file changed on the runner while a draft was open (file mode). */
  conflict?: boolean;
  saving?: boolean;
  reverting?: boolean;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  "update:modified": [value: string];
  "update:content": [value: string];
  selectPath: [path: string];
  save: [];
  revert: [];
  toggleReviewed: [];
  adoptConflict: [];
  overwriteConflict: [];
}>();

const isFullscreen = ref(false);
const confirmingRevert = ref(false);

// Split/inline follows the dialog's own width — the modal is 92vw windowed
// and 100vw fullscreen, so the viewport alone is not the width the diff gets.
// The header spans the dialog, so measuring it measures the content; before
// the first ResizeObserver tick the viewport breakpoint stands in.
const headerRef = ref<HTMLDivElement | null>(null);
const { width: modalWidth } = useElementSize(headerRef);
const isWideViewport = useMediaQuery("(min-width: 1024px)");
// An operator's toggle holds until the dialog closes; reopening recomputes
// the width-based default.
const sideBySideOverride = ref<boolean | null>(null);
const renderSideBySide = computed(() =>
  resolveSideBySide({
    override: sideBySideOverride.value,
    modalWidth: modalWidth.value,
    wideViewport: isWideViewport.value,
  }),
);

// The minimap toggle hides below 900px of modal width (spec §4.1); with the
// toggle gone the minimap itself is off, so it never eats the narrow column.
const minimapOn = ref(true);
const showMinimapToggle = computed(() =>
  minimapVisible({ modalWidth: modalWidth.value, wideViewport: isWideViewport.value }),
);
const minimapEnabled = computed(() => showMinimapToggle.value && minimapOn.value);

// Monaco computes the diff; the header's `+x -y` pill mirrors its hunks.
const diffStats = ref<LineChangeSummary | null>(null);

const fileName = computed(() => {
  const parts = props.path.split("/");
  return parts[parts.length - 1] || props.path;
});

const pathBreadcrumb = computed(() => {
  const parts = props.path.split("/");
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
});

const fileCounter = computed(() => {
  return formatFileCounter(props.allPaths, props.path);
});

const toggleFullscreen = () => {
  isFullscreen.value = !isFullscreen.value;
};

const handlePrevious = () => {
  const prevPath = findPrevPath(props.allPaths, props.path);
  if (prevPath) {
    emit("selectPath", prevPath);
  }
};

const handleNext = () => {
  const nextPath = findNextPath(props.allPaths, props.path);
  if (nextPath) {
    emit("selectPath", nextPath);
  }
};

const handleRevertRequest = () => {
  confirmingRevert.value = true;
};

const handleRevertConfirm = () => {
  confirmingRevert.value = false;
  emit("revert");
};

const handleRevertCancel = () => {
  confirmingRevert.value = false;
};

const handleSave = () => {
  emit("save");
};

const handleToggleReviewed = () => {
  const wasReviewed = props.isReviewed === true;
  emit("toggleReviewed");

  const nextPath = nextPathAfterToggleReview({
    paths: props.allPaths,
    currentPath: props.path,
    alreadyReviewed: wasReviewed,
    isPathReviewed: (checkPath) => props.isPathReviewed?.(checkPath) === true,
  });

  if (nextPath !== null) {
    emit("selectPath", nextPath);
    return;
  }

  // Unmarking a reviewed file stays on it; marking the last unreviewed file
  // closes the dialog.
  if (!wasReviewed) {
    toast.success("Đã duyệt toàn bộ thay đổi.");
    emit("update:open", false);
  }
};

const handleClose = () => {
  emit("update:open", false);
};

// Navigating to another file resets the inline revert confirmation and the
// previous file's `+x -y` counts (Monaco reports the new ones).
watch(
  () => props.path,
  () => {
    confirmingRevert.value = false;
    diffStats.value = null;
  },
);

// Escape restores a fullscreen dialog before the dialog dismisses it. The
// listener runs in the capture phase so it wins over reka-ui's
// DismissableLayer, which closes on Escape independently of our state.
watch(
  () => props.open,
  (newOpen, _, onCleanup) => {
    if (newOpen) {
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        if (isFullscreen.value) {
          e.preventDefault();
          e.stopPropagation();
          isFullscreen.value = false;
          return;
        }
        handleClose();
      };
      document.addEventListener("keydown", handleEscape, true);
      onCleanup(() => {
        document.removeEventListener("keydown", handleEscape, true);
      });
    }
    if (!newOpen) {
      // Reopening starts windowed with the width-based diff mode, the minimap
      // on, and no confirmation in flight (M18).
      isFullscreen.value = false;
      confirmingRevert.value = false;
      sideBySideOverride.value = null;
      minimapOn.value = true;
      diffStats.value = null;
    }
  },
  { immediate: true },
);
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent
      :class="cn(
        'flex flex-col p-0 gap-0 overflow-hidden border border-border bg-background',
        isFullscreen
          ? 'fixed inset-0 z-50 w-screen h-screen max-w-none rounded-none translate-x-0 translate-y-0 sm:max-w-none'
          : 'w-[92vw] h-[88vh] max-w-7xl sm:max-w-7xl rounded-xl'
      )"
      :show-close-button="false"
    >
      <!-- Header -->
      <div
        ref="headerRef"
        class="flex items-center justify-between border-b border-border px-4 py-3 bg-muted/20"
      >
        <div class="flex flex-col gap-0.5 min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <FileText class="h-4 w-4 shrink-0 text-muted-foreground" />
            <DialogTitle class="text-sm font-semibold truncate">
              {{ fileName }}
            </DialogTitle>
            <span
              v-if="statusLabel"
              class="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              {{ statusLabel }}
            </span>
            <span v-if="mode === 'diff' && diffStats !== null" class="shrink-0 font-mono text-[11px]">
              <span class="text-emerald-600 dark:text-emerald-500">+{{ diffStats.added }}</span>
              <span class="ml-1 text-destructive">-{{ diffStats.removed }}</span>
            </span>
            <span class="text-xs text-muted-foreground">
              {{ fileCounter }}
            </span>
          </div>
          <div v-if="pathBreadcrumb" class="text-xs text-muted-foreground truncate">
            {{ pathBreadcrumb }}
          </div>
        </div>

        <!-- Center: Navigation (only when there is more than one file) -->
        <div v-if="allPaths.length > 1" class="flex items-center gap-1 mx-4">
          <button
            type="button"
            class="p-1.5 hover:bg-muted rounded-md transition-colors"
            title="File trước"
            @click="handlePrevious"
          >
            <ChevronLeft class="h-4 w-4" />
          </button>
          <button
            type="button"
            class="p-1.5 hover:bg-muted rounded-md transition-colors"
            title="File tiếp theo"
            @click="handleNext"
          >
            <ChevronRight class="h-4 w-4" />
          </button>
        </div>

        <!-- Right: Controls -->
        <div class="flex items-center gap-1">
          <!-- Diff mode toggle -->
          <div v-if="mode === 'diff'" class="flex items-center gap-0.5 mr-2 border border-border rounded-md">
            <button
              type="button"
              :class="cn(
                'px-2 py-1 text-xs rounded-l-md transition-colors',
                renderSideBySide ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
              )"
              :aria-pressed="renderSideBySide"
              title="Hiển thị chia đôi"
              @click="sideBySideOverride = true"
            >
              <Columns2 class="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              :class="cn(
                'px-2 py-1 text-xs rounded-r-md transition-colors',
                !renderSideBySide ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
              )"
              :aria-pressed="!renderSideBySide"
              title="Hiển thị nội tuyến"
              @click="sideBySideOverride = false"
            >
              <Rows2 class="h-3.5 w-3.5" />
            </button>
          </div>

          <button
            v-if="mode === 'diff' && showMinimapToggle"
            type="button"
            class="p-1.5 hover:bg-muted rounded-md transition-colors"
            :class="minimapEnabled ? 'text-foreground' : 'text-muted-foreground'"
            :aria-pressed="minimapEnabled"
            :title="minimapEnabled ? 'Ẩn bản đồ thu nhỏ' : 'Hiện bản đồ thu nhỏ'"
            @click="minimapOn = !minimapOn"
          >
            <MapIcon class="h-4 w-4" />
          </button>

          <button
            type="button"
            class="p-1.5 hover:bg-muted rounded-md transition-colors"
            :title="isFullscreen ? 'Thu nhỏ' : 'Toàn màn hình'"
            @click="toggleFullscreen"
          >
            <Minimize2 v-if="isFullscreen" class="h-4 w-4" />
            <Maximize2 v-else class="h-4 w-4" />
          </button>
          <button
            type="button"
            class="p-1.5 hover:bg-muted rounded-md transition-colors"
            title="Đóng"
            @click="handleClose"
          >
            <X class="h-4 w-4" />
          </button>
        </div>
      </div>

      <!-- Body: Editor -->
      <div class="flex-1 min-h-0 overflow-hidden">
        <MonacoDiffEditor
          v-if="mode === 'diff'"
          :key="path"
          :original="original || ''"
          :modified="modified || ''"
          :path="path"
          :render-side-by-side="renderSideBySide"
          :minimap="minimapEnabled"
          @update:modified="emit('update:modified', $event)"
          @stats="diffStats = $event"
        />
        <MonacoCodeEditor
          v-else-if="mode === 'file'"
          :key="path"
          :content="content || ''"
          :path="path"
          @update:content="emit('update:content', $event)"
        />
      </div>

      <!-- Footer -->
      <div class="flex items-center justify-between gap-3 border-t border-border px-4 py-3 bg-muted/20">
        <!-- Left: error / conflict / dirty status -->
        <div class="flex min-w-0 items-center gap-2">
          <template v-if="conflict">
            <span class="truncate text-xs text-foreground">
              Tệp đã bị thay đổi trên Runner kể từ khi mở.
            </span>
            <button
              type="button"
              class="shrink-0 text-xs text-primary hover:underline disabled:opacity-50"
              :disabled="saving"
              @click="emit('adoptConflict')"
            >
              Tải bản mới (bỏ bản nháp)
            </button>
            <button
              type="button"
              class="shrink-0 rounded-md bg-destructive px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
              :disabled="saving"
              @click="emit('overwriteConflict')"
            >
              Ghi đè
            </button>
          </template>
          <span v-else-if="error" class="truncate text-xs text-destructive" :title="error">
            {{ error }}
          </span>
          <span v-else-if="dirty" class="text-xs text-muted-foreground">
            Chưa lưu thay đổi
          </span>
        </div>

        <!-- Right: Actions -->
        <div v-if="confirmingRevert" class="flex shrink-0 items-center gap-2">
          <span class="text-xs text-muted-foreground">Khôi phục tệp về bản chụp?</span>
          <button
            type="button"
            class="px-3 py-1.5 text-sm hover:bg-muted rounded-md transition-colors"
            @click="handleRevertCancel"
          >
            Huỷ
          </button>
          <button
            type="button"
            class="rounded-md bg-destructive px-3 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50"
            :disabled="reverting"
            @click="handleRevertConfirm"
          >
            Xác nhận
          </button>
        </div>
        <div v-else class="flex shrink-0 items-center gap-2">
          <button
            type="button"
            class="px-3 py-1.5 text-sm hover:bg-muted rounded-md transition-colors flex items-center gap-1.5 disabled:opacity-50"
            title="Khôi phục thay đổi"
            :disabled="reverting"
            @click="handleRevertRequest"
          >
            <RotateCcw class="h-3.5 w-3.5" />
            Khôi phục
          </button>
          <button
            type="button"
            :disabled="!dirty || saving"
            :class="cn(
              'px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1.5',
              dirty
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-muted text-muted-foreground cursor-not-allowed'
            )"
            title="Lưu thay đổi"
            @click="handleSave"
          >
            <Save class="h-3.5 w-3.5" />
            Lưu
          </button>
          <button
            v-if="mode === 'diff'"
            type="button"
            :class="cn(
              'px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1.5',
              isReviewed
                ? 'bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            )"
            :title="isReviewed ? 'Đã duyệt' : 'Đánh dấu đã duyệt'"
            @click="handleToggleReviewed"
          >
            <Check class="h-3.5 w-3.5" />
            {{ isReviewed ? '✓ Đã duyệt' : 'Đã duyệt' }}
          </button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
/* No additional styles needed, using Tailwind */
</style>
