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
import { useI18n } from "@/lib/i18n";
import { fetchDirectory, registerWorkspace } from "@/services/browse-api.ts";

/**
 * A modal directory browser for discovering a workspace on a runner (§15.1,
 * P3-B). The operator browses the runner host's filesystem via the never-throw
 * browse RPC and confirms a folder, which the modal emits as `select`.
 *
 * The modal only picks — it does not register. Registration is the caller's
 * decision, because a folder the runner already declared must be selected
 * rather than registered again under a fresh id (the control plane keys
 * workspaces on `(runnerId, workspaceId)`), and only the caller holds the
 * declared list to check against.
 *
 * All navigation state and the pure helpers live in `folder-browser.ts`; this
 * component only wires the DOM to the controller and renders with shadcn-vue
 * primitives. Localized UI copy throughout.
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

const { t } = useI18n();

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

function onConfirm(): void {
  const path = state.value.selectedPath;
  if (path === "") return;
  emit("select", path);
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
    <DialogContent class="sm:max-w-2xl max-h-[85dvh] flex flex-col gap-0 p-0 overflow-hidden">
      <DialogHeader class="shrink-0 border-b border-border px-4 py-4 pr-12 sm:px-6 sm:pr-12">
        <DialogTitle class="flex items-center gap-2">
          <FolderGit2 :size="20" class="text-primary shrink-0" />
          <span>{{ t("dialogs.selectFolderTitle") }}</span>
        </DialogTitle>
        <div class="mt-2 flex min-w-0 items-center gap-2">
          <Badge variant="secondary" class="min-w-0 max-w-[45%] shrink-0 truncate font-mono text-xs">
            {{ state.runnerId }}
          </Badge>
          <span class="text-xs text-muted-foreground truncate">
            /api/runners/{{ state.runnerId }}/browse
          </span>
        </div>
      </DialogHeader>

      <!-- Shortcuts bar: clickable badges to jump to common roots -->
      <div
        v-if="state.shortcuts.length > 0"
        class="flex shrink-0 flex-wrap gap-1.5 border-b border-border px-4 py-2.5 sm:px-6"
      >
        <button
          v-for="shortcut in state.shortcuts"
          :key="shortcut.path"
          type="button"
          class="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:min-h-0 sm:px-2.5 sm:py-1"
          @click="onShortcutClick(shortcut)"
        >
          <HardDrive :size="12" />
          {{ shortcut.label }}
        </button>
      </div>

      <!-- Breadcrumbs bar: clickable segments to jump to any ancestor -->
      <div class="flex shrink-0 items-center gap-1 border-b border-border px-4 py-2 text-xs sm:px-6">
        <Button
          v-if="state.parentPath !== null"
          variant="ghost"
          size="sm"
          class="h-9 w-9 shrink-0 px-1.5 sm:h-6 sm:w-auto"
          @click="onGoUp"
        >
          <ArrowUp :size="12" />
        </Button>
        <div class="flex min-w-0 flex-1 items-center gap-1 font-mono overflow-x-auto">
          <span
            class="text-muted-foreground hover:text-foreground shrink-0"
            style="cursor: pointer"
            @click="controller.navigate('')"
          >
            <Home :size="12" />
          </span>
          <template v-for="crumb in breadcrumbs(state.currentPath)" :key="crumb.path">
            <ChevronRight :size="12" class="text-muted-foreground/50 shrink-0" />
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
      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        <div v-if="state.loading" class="flex items-center justify-center py-8">
          <Loader2 :size="24" class="animate-spin text-muted-foreground" />
          <span class="ml-2 text-sm text-muted-foreground">{{ t("dialogs.loading") }}</span>
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
            {{ t("dialogs.retry") }}
          </Button>
        </div>

        <template v-else>
          <!-- Parent directory row -->
          <button
            v-if="state.parentPath !== null"
            type="button"
            class="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
            @click="controller.navigate(state.parentPath)"
          >
            <ArrowUp :size="14" class="text-muted-foreground" />
            <span class="text-foreground">..</span>
            <span class="text-xs text-muted-foreground">{{ t("dialogs.parentFolder") }}</span>
          </button>

          <!-- Folder list -->
          <ScrollArea v-if="state.entries.length > 0" class="h-72 overflow-hidden">
            <ul class="grid gap-0.5 pr-3">
              <li
                v-for="entry in state.entries"
                :key="entry.path"
                class="flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-2 text-sm transition-colors sm:min-h-0 sm:py-1.5"
                :class="state.selectedPath === entry.path ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted'"
                @click="entry.isDir ? onRowClick(entry) : undefined"
              >
                <div class="flex min-w-0 flex-1 items-center gap-2">
                  <Folder v-if="entry.isDir" :size="16" class="text-primary shrink-0" />
                  <File v-else :size="16" class="text-muted-foreground shrink-0" />
                  <span class="truncate">{{ entry.name }}</span>
                  <Badge
                    v-if="entry.isGitRepo"
                    variant="secondary"
                    class="text-xs font-medium shrink-0"
                  >
                    <FolderGit2 :size="10" class="mr-0.5" />Git
                  </Badge>
                  <Badge
                    v-if="entry.hasClaudeProject"
                    variant="outline"
                    class="text-xs font-medium shrink-0"
                  >
                    Claude Project
                  </Badge>
                </div>
                <Button
                  v-if="entry.isDir"
                  variant="ghost"
                  size="sm"
                  class="h-9 shrink-0 px-2 sm:h-6 sm:px-1.5"
                  @click.stop="onFolderSelect(entry)"
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
            {{ t("dialogs.noSubfolders") }}
          </p>
        </template>
      </div>

      <DialogFooter class="shrink-0 border-t border-border bg-popover px-4 py-4 sm:items-center sm:justify-between sm:px-6">
        <div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground font-mono sm:mr-auto">
          <span class="shrink-0">{{ t("dialogs.selected") }}</span>
          <code class="truncate rounded border border-border/60 bg-muted/30 px-1.5 py-0.5">
            {{ state.selectedPath || "—" }}
          </code>
        </div>

        <div class="flex w-full items-center justify-end gap-2 shrink-0">
          <Button variant="outline" class="max-sm:h-11" @click="onCancel">
            <X :size="14" />
            {{ t("dialogs.cancel") }}
          </Button>
          <Button
            :disabled="!state.selectedPath || state.loading"
            class="max-sm:h-11"
            @click="onConfirm"
          >
            <Check :size="14" />
            {{ t("dialogs.chooseFolder") }}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
