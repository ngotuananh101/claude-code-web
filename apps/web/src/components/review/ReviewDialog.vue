<script setup lang="ts">
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Maximize2,
  Minimize2,
  RotateCcw,
  Rows2,
  Save,
  X,
} from "@lucide/vue";
import { computed, onUnmounted, ref, watch } from "vue";
import { toast } from "vue-sonner";
import MonacoCodeEditor from "@/components/review/MonacoCodeEditor.vue";
import MonacoDiffEditor from "@/components/review/MonacoDiffEditor.vue";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  findNextPath,
  findNextUnreviewedPath,
  findPrevPath,
  formatFileCounter,
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
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  "update:modified": [value: string];
  "update:content": [value: string];
  selectPath: [path: string];
  save: [];
  revert: [];
  toggleReviewed: [];
}>();

const isFullscreen = ref(false);
const renderSideBySide = ref(window.innerWidth >= 1024);

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

const toggleSplitMode = () => {
  renderSideBySide.value = !renderSideBySide.value;
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

const handleRevert = () => {
  emit("revert");
};

const handleSave = () => {
  emit("save");
};

const handleToggleReviewed = () => {
  emit("toggleReviewed");

  // Check if other paths are already reviewed
  const isReviewedCheck = (checkPath: string) => {
    if (checkPath === props.path) return true; // current file was just marked reviewed
    return Boolean(props.isPathReviewed?.(checkPath));
  };

  const nextPath = findNextUnreviewedPath(props.allPaths, props.path, isReviewedCheck);

  if (nextPath) {
    emit("selectPath", nextPath);
  } else {
    // All reviewed
    toast.success("Đã duyệt toàn bộ thay đổi.");
    emit("update:open", false);
  }
};

const handleClose = () => {
  emit("update:open", false);
};

// Watch for escape key
watch(
  () => props.open,
  (newOpen, _, onCleanup) => {
    if (newOpen) {
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === "Escape" && !isFullscreen.value) {
          handleClose();
        }
      };
      document.addEventListener("keydown", handleEscape);
      onCleanup(() => {
        document.removeEventListener("keydown", handleEscape);
      });
    }
  },
  { immediate: true },
);

// Cleanup on unmount
onUnmounted(() => {
  // Any remaining event listeners will be cleaned up
});
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent
      :class="cn(
        'flex flex-col p-0 gap-0 overflow-hidden border border-border bg-background',
        isFullscreen
          ? 'fixed inset-0 z-50 w-screen h-screen max-w-none rounded-none'
          : 'w-[92vw] h-[88vh] max-w-7xl rounded-xl'
      )"
      :show-close-button="false"
    >
      <!-- Header -->
      <div class="flex items-center justify-between border-b border-border px-4 py-3 bg-muted/20">
        <div class="flex flex-col gap-0.5 min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <DialogTitle class="text-sm font-semibold truncate">
              {{ fileName }}
            </DialogTitle>
            <span class="text-xs text-muted-foreground">
              {{ fileCounter }}
            </span>
          </div>
          <div v-if="pathBreadcrumb" class="text-xs text-muted-foreground truncate">
            {{ pathBreadcrumb }}
          </div>
        </div>

        <!-- Center: Navigation -->
        <div class="flex items-center gap-1 mx-4">
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
              title="Hiển thị chia đôi"
              @click="renderSideBySide = true"
            >
              <Columns2 class="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              :class="cn(
                'px-2 py-1 text-xs rounded-r-md transition-colors',
                !renderSideBySide ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
              )"
              title="Hiển thị nội tuyến"
              @click="renderSideBySide = false"
            >
              <Rows2 class="h-3.5 w-3.5" />
            </button>
          </div>

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
          @update:modified="emit('update:modified', $event)"
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
      <div class="flex items-center justify-between border-t border-border px-4 py-3 bg-muted/20">
        <!-- Left: Dirty indicator -->
        <div class="flex items-center gap-2">
          <span v-if="dirty" class="text-xs text-muted-foreground">
            Chưa lưu thay đổi
          </span>
        </div>

        <!-- Right: Actions -->
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="px-3 py-1.5 text-sm hover:bg-muted rounded-md transition-colors flex items-center gap-1.5"
            title="Khôi phục thay đổi"
            @click="handleRevert"
          >
            <RotateCcw class="h-3.5 w-3.5" />
            Khôi phục
          </button>
          <button
            type="button"
            :disabled="!dirty"
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
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
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
