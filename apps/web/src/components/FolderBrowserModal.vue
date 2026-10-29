<script setup lang="ts">
import {
  AlertCircle,
  ArrowUp,
  Check,
  ChevronRight,
  File,
  Folder,
  FolderGit2,
  HardDrive,
  Home,
  Loader2,
  X,
} from "@lucide/vue";
import { watch } from "vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { breadcrumbs, createFolderBrowser } from "@/features/browse/folder-browser.ts";
import { fetchDirectory, registerWorkspace } from "@/services/browse-api.ts";

/**
 * A modal directory browser for discovering a workspace on a runner (§15.1,
 * P3-B). The operator picks a runner, browses its host filesystem via the
 * never-throw browse RPC, and either confirms a folder (emits `select`) or
 * registers a custom path (POSTs `registerWorkspace`).
 *
 * All navigation state and the pure helpers live in `folder-browser.ts`; this
 * component only wires the DOM to the controller and renders with shadcn-vue
 * primitives. Vietnamese UI copy throughout.
 */

const props = withDefaults(
  defineProps<{
    /** Whether the modal is visible. */
    open: boolean;
    /** The runner to browse directories on. */
    runnerId: string;
    /** An initial path to navigate to when the modal opens. */
    initialPath?: string;
  }>(),
  { open: false, runnerId: "", initialPath: "" },
);

const emit = defineEmits<{
  (e: "close"): void;
  (e: "select", path: string): void;
}>();

const controller = createFolderBrowser(props.runnerId, { fetchDirectory, registerWorkspace });

const { state } = controller;

// When the modal opens or the runnerId changes, start browsing from the root
// or the initial path.
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      const path = props.initialPath;
      void controller.navigate(path ?? "");
    }
  },
  { immediate: true },
);

// Reflect prop changes into state immediately (runnerId swap, initialPath).
watch(
  () => props.runnerId,
  (newRunnerId) => {
    state.value.runnerId = newRunnerId;
  },
);

function onCancel(): void {
  emit("close");
}

async function onConfirm(): Promise<void> {
  const outcome = await controller.registerWorkspace();
  if (outcome.ok) {
    emit("select", outcome.value.path);
  }
}

function onRetry(): void {
  void controller.navigate(state.value.currentPath);
}

function onBreadcrumbClick(path: string): void {
  void controller.navigate(path);
}

function onShortcutClick(shortcut: { label: string; path: string }): void {
  void controller.selectShortcut(shortcut);
}

function onGoUp(): void {
  void controller.goUp();
}

function onFolderSelect(entry: { name: string; path: string }): void {
  controller.selectFolder(entry.path);
}

/** Navigate into a directory row on click. */
function onRowClick(entry: { path: string; isDir: boolean }): void {
  if (entry.isDir) {
    void controller.navigate(entry.path);
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="val => { if (!val) emit('close'); }">
    <DialogContent class="max-w-2xl p-0">
      <DialogHeader class="border-b border-border px-6 py-4">
        <DialogTitle class="flex items-center gap-2">
          <FolderGit2 :size="20" class="text-primary" />
          Chọn thư mục trên Runner
        </DialogTitle>
        <div class="mt-2 flex items-center gap-2">
          <Badge variant="secondary" class="font-mono text-xs">
            {{ state.runnerId }}
          </Badge>
          <span class="text-xs text-muted-foreground">
            /api/runners/{{ state.runnerId }}/browse
          </span>
        </div>
      </DialogHeader>

      <!-- Shortcuts bar: clickable badges to jump to common roots -->
      <div
        v-if="state.shortcuts.length > 0"
        class="flex flex-wrap gap-1.5 border-b border-border px-6 py-2.5"
      >
        <button
          v-for="shortcut in state.shortcuts"
          :key="shortcut.path"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          @click="onShortcutClick(shortcut)"
        >
          <HardDrive :size="12" />
          {{ shortcut.label }}
        </button>
      </div>

      <!-- Breadcrumbs bar: clickable segments to jump to any ancestor -->
      <div class="flex items-center gap-1 border-b border-border px-6 py-2 text-xs">
        <Button
          v-if="state.parentPath !== null"
          variant="ghost"
          size="sm"
          class="h-6 px-1.5"
          @click="onGoUp"
        >
          <ArrowUp :size="12" />
        </Button>
        <div class="flex items-center gap-1 font-mono">
          <span
            class="text-muted-foreground hover:text-foreground"
            style="cursor: pointer"
            @click="controller.navigate('')"
          >
            <Home :size="12" />
          </span>
          <template v-for="crumb in breadcrumbs(state.currentPath)" :key="crumb.path">
            <ChevronRight :size="12" class="text-muted-foreground/50" />
            <button
              type="button"
              class="truncate text-muted-foreground hover:text-foreground hover:underline"
              @click="onBreadcrumbClick(crumb.path)"
            >
              {{ crumb.name }}
            </button>
          </template>
        </div>
      </div>

      <!-- Content area: loading / error / entries -->
      <div class="px-6 py-4">
        <div v-if="state.loading" class="flex items-center justify-center py-8">
          <Loader2 :size="24" class="animate-spin text-muted-foreground" />
          <span class="ml-2 text-sm text-muted-foreground">Đang tải…</span>
        </div>

        <div
          v-else-if="state.error !== null"
          class="flex items-start gap-2.5 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5"
        >
          <AlertCircle :size="16" class="mt-0.5 shrink-0 text-destructive" />
          <span class="text-sm text-destructive">{{ state.error }}</span>
          <Button
            variant="ghost"
            size="sm"
            class="ml-auto shrink-0"
            @click="onRetry"
          >
            Thử lại
          </Button>
        </div>

        <template v-else>
          <!-- Parent directory row -->
          <button
            v-if="state.parentPath !== null"
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
            @click="controller.navigate(state.parentPath)"
          >
            <ArrowUp :size="14" class="text-muted-foreground" />
            <span class="text-foreground">..</span>
            <span class="text-xs text-muted-foreground">Thư mục cha</span>
          </button>

          <!-- Folder list -->
          <ScrollArea v-if="state.entries.length > 0" class="max-h-72">
            <ul class="grid gap-0.5">
            <li
              v-for="entry in state.entries"
              :key="entry.path"
              class="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
              @click="entry.isDir ? onRowClick(entry) : undefined"
            >
              <div class="flex items-center gap-2">
                <Folder v-if="entry.isDir" :size="16" class="text-primary" />
                <File v-else :size="16" class="text-muted-foreground" />
                <span class="truncate">{{ entry.name }}</span>
                <Badge
                  v-if="entry.isGitRepo"
                  variant="secondary"
                  class="text-xs font-medium"
                >
                  <FolderGit2 :size="10" class="mr-0.5" />Git
                </Badge>
                <Badge
                  v-if="entry.hasClaudeProject"
                  variant="outline"
                  class="text-xs font-medium"
                >
                  Claude Project
                </Badge>
              </div>
              <Button
                v-if="entry.isDir"
                variant="ghost"
                size="sm"
                class="h-6 shrink-0 px-1.5"
                @click="onFolderSelect(entry)"
              >
                <Check :size="12" />
              </Button>
            </li>
          </ul>
          </ScrollArea>

          <!-- Empty state -->
          <p
            v-else
            class="py-4 text-center text-sm text-muted-foreground"
          >
            Thư mục này không có thư mục con.
          </p>
        </template>
      </div>

      <DialogFooter class="border-t border-border px-6 py-4">
        <div class="flex items-center gap-2 text-xs text-muted-foreground font-mono">
          <span>Đang chọn:</span>
          <code class="rounded border border-border/60 bg-muted/30 px-1.5 py-0.5">
            {{ state.selectedPath || "—" }}
          </code>
        </div>

        <Button variant="outline" @click="onCancel">
          <X :size="14" />
          Hủy
        </Button>
        <Button
          :disabled="!state.selectedPath || state.loading"
          @click="onConfirm"
        >
          <Check :size="14" />
          Chọn thư mục này
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
