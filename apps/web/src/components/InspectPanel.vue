<script setup lang="ts">
import type {
  DiagnosticsResult,
  FileListResult,
  FileReadResult,
  GitChangesResult,
  GitDiffResult,
  SnapshotStatusResult,
} from "@cc-web/protocol";
import { computed, ref, watch } from "vue";
import { classifyDiffLines } from "../features/inspect/diff";
import { isDirty, viewerAfterSave } from "../features/inspect/edit";
import { formatSize } from "../features/inspect/format";
import { breadcrumbs, joinPath, parentPath } from "../features/inspect/paths";
import { canApplyPlan, summarisePlan } from "../features/inspect/revert";
import {
  compositeId,
  fetchChanges,
  fetchDiagnostics,
  fetchDiff,
  fetchSnapshotStatus,
  listFiles,
  readFile,
  revertFile,
  revertWorkspace,
  writeFile,
} from "../services/inspect-api";
import { sessions } from "../stores/sessions.ts";

/**
 * Read-only inspection beside the conversation (§16.1's secondary panel,
 * P3-A ruling 12).
 *
 * Files / Changes / Diagnostics, all answered through the bounded RPC channel:
 * one directory per call, plain text in a `<pre>`, and no controls that would
 * imply a mutation — save, revert and accept/reject are P3-B/P3-D (§16.4).
 *
 * The composite workspace id comes from the session's pin, which the rail's
 * own list already carries (T10) — a pre-pin session answers null and the
 * panel says so instead of guessing where the session runs.
 */

const props = defineProps<{ sessionId: string }>();

type Tab = "files" | "changes" | "diagnostics";
const TAB_LABELS: Record<Tab, string> = {
  files: "Files",
  changes: "Changes",
  diagnostics: "Diagnostics",
};

const tab = ref<Tab>("files");

const activeSession = computed(() =>
  sessions.sessions.find((row) => row.sessionId === props.sessionId),
);

/** One encoded path segment, or null when the session has no pin. */
const workspace = computed(() => {
  const row = activeSession.value;
  if (row === undefined || row.runnerId === null || row.workspaceId === null) return null;
  return compositeId(row.runnerId, row.workspaceId);
});

// Files
const directory = ref("");
const listing = ref<FileListResult | null>(null);
const filesError = ref<string | null>(null);
const filesLoading = ref(false);
const viewer = ref<FileReadResult | null>(null);

// Files editor (P3-B save)
const draft = ref<string | null>(null);
const saving = ref(false);
const saveError = ref<string | null>(null);

// Changes
const changes = ref<GitChangesResult | null>(null);
const changesError = ref<string | null>(null);
const changesLoading = ref(false);
const diff = ref<GitDiffResult | null>(null);
const diffPath = ref<string | null>(null);
const diffError = ref<string | null>(null);
const diffLoading = ref(false);

// Changes — snapshot source (P3-B baseline)
const source = ref<"git" | "snapshot">("snapshot");
const snapshotStatus = ref<SnapshotStatusResult | null>(null);
const snapshotError = ref<string | null>(null);
const snapshotLoading = ref(false);
const confirmingPath = ref<string | null>(null);
const workspaceRevertConfirm = ref(false);

// Diagnostics
const diagnostics = ref<DiagnosticsResult | null>(null);
const diagnosticsError = ref<string | null>(null);
const diagnosticsLoading = ref(false);

/**
 * Every load bumps this; a response whose epoch is stale is dropped instead of
 * written into a panel that has since moved to another directory, tab or
 * session. Without it, switching sessions mid-fetch painted the previous
 * workspace's listing under the new session's header.
 */
let epoch = 0;

const crumbs = computed(() => breadcrumbs(directory.value));

// The runner is trusted to be well-behaved, not to be bug-free: a wrongly typed
// result must not tear down the whole panel's render.
const entries = computed(() => {
  const value = listing.value?.entries;
  return Array.isArray(value) ? value : [];
});

const changeEntries = computed(() => {
  const value = changes.value?.entries;
  return Array.isArray(value) ? value : [];
});

const diffLines = computed(() => {
  const text = diff.value?.diff;
  return typeof text === "string" ? classifyDiffLines(text) : [];
});

const STATUS_LABELS: Record<string, string> = {
  added: "thêm",
  modified: "sửa",
  deleted: "xoá",
  renamed: "đổi tên",
  copied: "sao chép",
  untracked: "chưa theo dõi",
  conflicted: "xung đột",
  typechange: "đổi loại",
};

async function loadFiles(dir: string): Promise<void> {
  const id = workspace.value;
  if (id === null) return;
  const current = ++epoch;
  filesLoading.value = true;
  filesError.value = null;
  viewer.value = null;
  const outcome = await listFiles(id, dir);
  if (current !== epoch) return;
  filesLoading.value = false;
  if (!outcome.ok) {
    filesError.value = outcome.message;
    listing.value = null;
    return;
  }
  directory.value = dir;
  listing.value = outcome.value;
}

async function loadChanges(): Promise<void> {
  const id = workspace.value;
  if (id === null) return;
  const current = ++epoch;
  changesLoading.value = true;
  changesError.value = null;
  diff.value = null;
  diffPath.value = null;
  diffError.value = null;
  const outcome = await fetchChanges(id);
  if (current !== epoch) return;
  changesLoading.value = false;
  if (!outcome.ok) {
    changesError.value = outcome.message;
    changes.value = null;
    return;
  }
  changes.value = outcome.value;
}

async function loadDiagnostics(): Promise<void> {
  const id = workspace.value;
  if (id === null) return;
  const current = ++epoch;
  diagnosticsLoading.value = true;
  diagnosticsError.value = null;
  const outcome = await fetchDiagnostics(id);
  if (current !== epoch) return;
  diagnosticsLoading.value = false;
  if (!outcome.ok) {
    diagnosticsError.value = outcome.message;
    diagnostics.value = null;
    return;
  }
  diagnostics.value = outcome.value;
}

async function openEntry(name: string, kind: "file" | "directory" | "other"): Promise<void> {
  const id = workspace.value;
  if (id === null) return;
  const path = joinPath(directory.value, name);
  if (kind === "directory") {
    await loadFiles(path);
    return;
  }
  if (kind !== "file") return;

  const current = ++epoch;
  filesLoading.value = true;
  filesError.value = null;
  saving.value = false;
  saveError.value = null;
  const outcome = await readFile(id, path);
  if (current !== epoch) return;
  filesLoading.value = false;
  if (!outcome.ok) {
    filesError.value = outcome.message;
    viewer.value = null;
    draft.value = null;
    return;
  }
  viewer.value = outcome.value;
  // Editable only for text, untruncated files with content available.
  if (!outcome.value.binary && !outcome.value.truncated && outcome.value.content !== null) {
    draft.value = outcome.value.content;
  } else {
    draft.value = null;
  }
}

async function openDiff(path: string): Promise<void> {
  const id = workspace.value;
  if (id === null) return;
  const current = ++epoch;
  diffLoading.value = true;
  diffError.value = null;
  const outcome = await fetchDiff(id, path);
  if (current !== epoch) return;
  diffLoading.value = false;
  if (!outcome.ok) {
    // The changes list stays; only the diff failed, and the operator can pick
    // another file without losing the list they were reading.
    diffError.value = outcome.message;
    return;
  }
  diff.value = outcome.value;
  diffPath.value = path;
}

async function loadSnapshot(): Promise<void> {
  const id = workspace.value;
  if (id === null) return;
  const current = ++epoch;
  snapshotLoading.value = true;
  snapshotError.value = null;
  const outcome = await fetchSnapshotStatus(id);
  if (current !== epoch) return;
  snapshotLoading.value = false;
  if (!outcome.ok) {
    snapshotError.value = outcome.message;
    snapshotStatus.value = null;
    return;
  }
  snapshotStatus.value = outcome.value;
}

async function saveFile(): Promise<void> {
  const id = workspace.value;
  if (id === null) return;
  if (viewer.value === null || draft.value === null) return;

  // Capture the current epoch without bumping it: the save belongs to the
  // epoch that opened the file, and a stale epoch drops the response.
  const current = epoch;
  saving.value = true;
  saveError.value = null;
  const outcome = await writeFile(id, viewer.value.path, draft.value, viewer.value.hash);
  if (current !== epoch) return;
  saving.value = false;
  if (!outcome.ok) {
    saveError.value = outcome.message;
    return;
  }
  viewer.value = viewerAfterSave(viewer.value, draft.value, outcome.value);
  draft.value = outcome.value.content;
  void loadFiles(directory.value);
}

async function revertOneFile(entry: { path: string; currentHash: string | null }): Promise<void> {
  const id = workspace.value;
  if (id === null) return;
  const current = ++epoch;
  confirmingPath.value = null;
  const outcome = await revertFile(id, entry.path, entry.currentHash);
  if (current !== epoch) return;
  if (!outcome.ok) {
    snapshotError.value = outcome.message;
    return;
  }
  void loadSnapshot();
  if (source.value === "git") void loadChanges();
}

async function doRevertWorkspace(): Promise<void> {
  const id = workspace.value;
  if (id === null) return;
  if (snapshotStatus.value === null) return;
  const applicable = canApplyPlan(snapshotStatus.value);
  if (!applicable.ok) {
    snapshotError.value = applicable.reason;
    return;
  }
  const current = ++epoch;
  workspaceRevertConfirm.value = false;
  const outcome = await revertWorkspace(id, snapshotStatus.value.digest ?? "");
  if (current !== epoch) return;
  if (!outcome.ok) {
    snapshotError.value = outcome.message;
    return;
  }
  void loadSnapshot();
  if (source.value === "git") void loadChanges();
}

function reloadFile(name: string): void {
  void loadFiles(directory.value);
  void openEntry(name, "file");
}

function goUp(): void {
  const parent = parentPath(directory.value);
  if (parent !== undefined) void loadFiles(parent);
}

// A different session is a different workspace: drop everything the previous
// one showed rather than presenting its contents under a new header. The key
// is a primitive so the rail's 15 s refresh — which replaces the session array
// but not this session's pin — does not reset the panel mid-navigation.
watch(
  () => `${props.sessionId}\u0000${workspace.value ?? ""}`,
  () => {
    // Cancel whatever was in flight: its response belongs to the previous
    // session's workspace and must not land in this one's panel.
    epoch += 1;
    directory.value = "";
    listing.value = null;
    viewer.value = null;
    filesError.value = null;
    filesLoading.value = false;
    draft.value = null;
    saving.value = false;
    saveError.value = null;
    changes.value = null;
    changesError.value = null;
    changesLoading.value = false;
    diff.value = null;
    diffPath.value = null;
    diffError.value = null;
    diffLoading.value = false;
    snapshotStatus.value = null;
    snapshotError.value = null;
    snapshotLoading.value = false;
    confirmingPath.value = null;
    workspaceRevertConfirm.value = false;
    diagnostics.value = null;
    diagnosticsError.value = null;
    diagnosticsLoading.value = false;
    if (workspace.value !== null) void loadFiles("");
  },
  { immediate: true },
);

watch(tab, (next) => {
  if (workspace.value === null) return;
  if (next === "files" && listing.value === null) void loadFiles(directory.value);
  if (next === "changes") {
    if (source.value === "git" && changes.value === null) void loadChanges();
    if (source.value === "snapshot" && snapshotStatus.value === null) void loadSnapshot();
  }
  if (next === "diagnostics" && diagnostics.value === null) void loadDiagnostics();
});
</script>

<template>
  <aside class="flex min-h-0 flex-col bg-card/40">
    <nav class="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-2">
      <button
        v-for="(label, key) in TAB_LABELS"
        :key="key"
        type="button"
        class="rounded-md px-2.5 py-1 font-mono text-xs transition-colors"
        :class="
          tab === key
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:text-foreground'
        "
        @click="tab = key"
      >
        {{ label }}
      </button>
    </nav>

    <div
      v-if="workspace === null"
      class="flex flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground"
    >
      Chưa xác định được workspace của phiên này.
    </div>

    <div v-else class="min-h-0 flex-1 overflow-y-auto px-3 py-2.5 font-mono text-xs">
      <!-- Files -->
      <template v-if="tab === 'files'">
        <div class="mb-2 flex flex-wrap items-center gap-1 text-muted-foreground">
          <button type="button" class="hover:text-foreground" @click="loadFiles('')">
            workspace
          </button>
          <template v-for="crumb in crumbs" :key="crumb.path">
            <span>/</span>
            <button type="button" class="hover:text-foreground" @click="loadFiles(crumb.path)">
              {{ crumb.name }}
            </button>
          </template>
        </div>

        <p v-if="filesLoading" class="text-muted-foreground">Đang tải…</p>
        <p v-else-if="filesError !== null" class="text-destructive">{{ filesError }}</p>

        <template v-else-if="viewer !== null">
          <div class="mb-2 flex items-center justify-between gap-2">
            <span class="truncate text-muted-foreground">{{ viewer.path }}</span>
            <button
              type="button"
              class="shrink-0 text-primary hover:underline"
              @click="viewer = null"
            >
              đóng
            </button>
          </div>
          <p
            v-if="viewer.binary"
            class="mb-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-muted-foreground"
          >
            Tệp nhị phân — không hiển thị nội dung.
          </p>
          <p
            v-if="viewer.truncated"
            class="mb-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-muted-foreground"
          >
            Nội dung đã được rút gọn — chỉ hiển thị phần đầu của tệp.
          </p>

          <!-- Editor (P3-B save): textarea only for text, untruncated files. -->
          <template v-if="draft !== null">
            <div class="mb-2 flex items-center justify-between gap-2">
              <span class="text-muted-foreground">bản nháp</span>
              <button
                type="button"
                class="shrink-0 text-primary hover:underline disabled:opacity-50"
                :disabled="
                  draft === null ||
                  saving ||
                  !isDirty(viewer.content ?? '', draft)
                "
                @click="saveFile"
              >
                {{ saving ? "đang lưu…" : "lưu" }}
              </button>
            </div>
            <p
              v-if="saveError !== null"
              class="mb-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-destructive"
            >
              {{ saveError }}
              <button
                v-if="viewer !== null"
                type="button"
                class="ml-2 text-primary hover:underline"
                @click="reloadFile(viewer.path.split('/').pop() ?? viewer.path)"
              >
                tải lại
              </button>
            </p>
            <textarea
              v-model="draft"
              class="w-full resize-y overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-background/60 p-2 font-mono text-xs text-foreground"
              rows="16"
            />
          </template>

          <pre
            v-else-if="viewer.content !== null"
            class="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-background/60 p-2"
            >{{ viewer.content }}</pre
          >
          <p v-else class="text-muted-foreground">Không có nội dung để hiển thị.</p>
        </template>

        <template v-else-if="listing !== null">
          <div class="mb-1.5 flex items-center justify-between gap-2 text-muted-foreground">
            <span>{{ entries.length }} mục</span>
            <button
              v-if="directory !== ''"
              type="button"
              class="text-primary hover:underline"
              @click="goUp"
            >
              lên trên
            </button>
          </div>
          <p
            v-if="listing.truncated"
            class="mb-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-muted-foreground"
          >
            Danh sách đã được rút gọn — hiển thị 2000 mục đầu tiên.
          </p>
          <ul class="grid gap-0.5">
            <li v-for="entry in entries" :key="entry.name">
              <button
                type="button"
                class="flex w-full items-baseline justify-between gap-3 rounded px-1.5 py-0.5 text-left hover:bg-background/60"
                @click="openEntry(entry.name, entry.kind)"
              >
                <span
                  class="truncate"
                  :class="entry.kind === 'directory' ? 'text-primary' : 'text-foreground'"
                >
                  {{ entry.name }}{{ entry.kind === "directory" ? "/" : "" }}
                </span>
                <span v-if="entry.kind === 'file'" class="shrink-0 text-muted-foreground">
                  {{ formatSize(entry.size) }}
                </span>
              </button>
            </li>
          </ul>
          <p v-if="entries.length === 0" class="text-muted-foreground">
            Thư mục trống.
          </p>
        </template>
      </template>

      <!-- Changes -->
      <template v-else-if="tab === 'changes'">
        <div class="mb-2 flex items-center justify-between gap-2">
          <div class="flex items-center gap-1 text-muted-foreground">
            <span>So sánh:</span>
            <button
              type="button"
              class="rounded-md px-2 py-0.5 text-xs transition-colors"
              :class="
                source === 'git'
                  ? 'bg-primary/10 text-primary'
                  : 'hover:text-foreground'
              "
              @click="source = 'git'"
            >
              Git (HEAD)
            </button>
            <button
              type="button"
              class="rounded-md px-2 py-0.5 text-xs transition-colors"
              :class="
                source === 'snapshot'
                  ? 'bg-primary/10 text-primary'
                  : 'hover:text-foreground'
              "
              @click="source = 'snapshot'"
            >
              Từ lúc bắt đầu chạy
            </button>
          </div>
          <template v-if="source === 'git'">
            <button type="button" class="text-primary hover:underline" @click="loadChanges">
              làm mới
            </button>
          </template>
          <template v-else>
            <button type="button" class="text-primary hover:underline" @click="loadSnapshot">
              làm mới
            </button>
          </template>
        </div>

        <!-- Git source (existing view) -->
        <template v-if="source === 'git'">
          <p v-if="changesLoading" class="text-muted-foreground">Đang tải…</p>
          <p v-else-if="changesError !== null" class="text-destructive">{{ changesError }}</p>

          <template v-else-if="diff !== null">
            <div class="mb-2 flex items-center justify-between gap-2">
              <span class="truncate text-muted-foreground">{{ diffPath }}</span>
              <button
                type="button"
                class="shrink-0 text-primary hover:underline"
                @click="diff = null"
              >
                đóng
              </button>
            </div>
            <p
              v-if="diff.truncated"
              class="mb-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-muted-foreground"
            >
              Diff đã được rút gọn.
            </p>
            <pre class="overflow-x-auto whitespace-pre rounded-md bg-background/60 p-2"><code>
<span
  v-for="(line, index) in diffLines"
  :key="index"
  :class="{
    'text-emerald-600 dark:text-emerald-400': line.kind === 'add',
    'text-red-600 dark:text-red-400': line.kind === 'remove',
    'text-muted-foreground': line.kind === 'meta',
  }"
>{{ line.text }}
</span></code></pre>
            <p v-if="diffLines.length === 0" class="text-muted-foreground">Không có diff.</p>
          </template>

          <template v-else-if="changes !== null">
            <!-- A failed diff keeps the list: only the diff failed, and the
                 operator can pick another file without losing their place. -->
            <p v-if="diffLoading" class="mb-1.5 text-muted-foreground">Đang tải diff…</p>
            <p v-else-if="diffError !== null" class="mb-1.5 text-destructive">{{ diffError }}</p>
            <p
              v-if="changes.truncated"
              class="mb-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-muted-foreground"
            >
              Danh sách đã được rút gọn — hiển thị 2000 thay đổi đầu tiên.
            </p>
            <ul class="grid gap-0.5">
              <li v-for="entry in changeEntries" :key="entry.path">
                <button
                  type="button"
                  class="flex w-full items-baseline justify-between gap-3 rounded px-1.5 py-0.5 text-left hover:bg-background/60"
                  @click="openDiff(entry.path)"
                >
                  <span class="truncate">
                    {{ entry.path }}
                    <span v-if="entry.origPath" class="text-muted-foreground">← {{ entry.origPath }}</span>
                  </span>
                  <span class="shrink-0 text-muted-foreground">
                    {{ STATUS_LABELS[entry.status] ?? entry.status }}
                  </span>
                </button>
              </li>
            </ul>
            <p v-if="changeEntries.length === 0" class="text-muted-foreground">
              Working tree sạch — không có thay đổi nào.
            </p>
          </template>
        </template>

        <!-- Snapshot source (P3-B baseline) -->
        <template v-else>
          <p v-if="snapshotLoading" class="text-muted-foreground">Đang tải…</p>
          <p v-else-if="snapshotError !== null" class="text-destructive">{{ snapshotError }}</p>

          <template v-else-if="snapshotStatus !== null">
            <div v-if="snapshotStatus.baseline === null" class="text-muted-foreground">
              Chưa có bản chụp lúc bắt đầu chạy.
            </div>

            <template v-else>
              <div class="mb-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5">
                <div class="text-muted-foreground">
                  Baseline: attempt {{ snapshotStatus.baseline.attemptId }}
                  <span v-if="snapshotStatus.baseline.sessionId !== null">
                    — phiên {{ snapshotStatus.baseline.sessionId }}
                  </span>
                  , {{ new Date(snapshotStatus.baseline.capturedAt).toLocaleString() }}
                </div>
                <div v-if="snapshotStatus.baseline.partial" class="text-destructive">
                  Bản chụp không đầy đủ.
                </div>
                <div v-if="snapshotStatus.truncated" class="text-destructive">
                  Danh sách thay đổi đã bị rút gọn.
                </div>
              </div>

              <div class="mb-2 flex items-center justify-between gap-2">
                <span class="text-muted-foreground">
                  {{ snapshotStatus.entries.length }} mục
                </span>
                <button
                  v-if="summarisePlan(snapshotStatus).restores +
                         summarisePlan(snapshotStatus).deletions > 0"
                  type="button"
                  class="text-primary hover:underline"
                  @click="workspaceRevertConfirm = true"
                >
                  Khôi phục cả workspace
                </button>
              </div>

              <ul class="grid gap-0.5">
                <li
                  v-for="entry in snapshotStatus.entries"
                  :key="entry.path"
                  class="flex w-full items-baseline justify-between gap-3 rounded px-1.5 py-0.5 text-left"
                >
                  <span class="truncate">
                    {{ entry.path }}
                    <span v-if="entry.reason" class="text-muted-foreground">
                      — {{ entry.reason }}
                    </span>
                  </span>
                  <span v-if="entry.status === 'modified'" class="shrink-0 text-muted-foreground">
                    sửa
                  </span>
                  <span v-else-if="entry.status === 'created'" class="shrink-0 text-muted-foreground">
                    thêm
                  </span>
                  <span v-else-if="entry.status === 'deleted'" class="shrink-0 text-muted-foreground">
                    xoá
                  </span>
                  <span v-else-if="entry.status === 'excluded'" class="shrink-0 text-muted-foreground">
                    loại trừ
                  </span>

                  <!-- Per-file revert with inline confirm -->
                  <template v-if="entry.revertable && entry.status !== 'excluded'">
                    <template v-if="confirmingPath.value === entry.path">
                      <button
                        type="button"
                        class="shrink-0 text-red-600 hover:underline"
                        @click="revertOneFile({ path: entry.path, currentHash: entry.currentHash })"
                      >
                        xác nhận
                      </button>
                    </template>
                    <template v-else>
                      <button
                        type="button"
                        class="shrink-0 text-primary hover:underline"
                        @click="confirmingPath.value = entry.path"
                      >
                        khôi phục
                      </button>
                    </template>
                  </template>
                </li>
              </ul>
            </template>
          </template>

          <!-- Workspace revert confirmation panel -->
          <div
            v-if="workspaceRevertConfirm && snapshotStatus !== null && snapshotStatus.baseline !== null"
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          >
            <div class="w-full max-w-lg rounded-md border border-border/60 bg-card p-4 font-mono text-xs">
              <h3 class="mb-3 text-sm font-medium">Xác nhận khôi phục toàn bộ workspace</h3>
              <div v-if="snapshotStatus" class="mb-3 space-y-1 text-muted-foreground">
                <div>
                  Khôi phục: {{ summarisePlan(snapshotStatus).restores }} tệp
                </div>
                <div>Xóa: {{ summarisePlan(snapshotStatus).deletions }} tệp</div>
                <div>Xung đột: {{ summarisePlan(snapshotStatus).conflicts }} mục</div>
              </div>

              <div v-if="canApplyPlan(snapshotStatus).ok === false" class="mb-3 text-destructive">
                {{ (canApplyPlan(snapshotStatus) as { ok: false; reason: string }).reason }}
              </div>

              <div class="mb-3 max-h-60 overflow-y-auto">
                <div v-if="snapshotStatus.entries.filter((e) => e.status === 'modified' || e.status === 'deleted').length > 0" class="mb-2">
                  <div class="font-medium text-muted-foreground">Khôi phục:</div>
                  <div
                    v-for="e in snapshotStatus.entries.filter((e) => e.status === 'modified' || e.status === 'deleted').slice(0, 50)"
                    :key="e.path"
                    class="truncate"
                  >
                    {{ e.path }}
                  </div>
                </div>
                <div v-if="snapshotStatus.entries.filter((e) => e.status === 'created').length > 0" class="mb-2">
                  <div class="font-medium text-muted-foreground">Xóa:</div>
                  <div
                    v-for="e in snapshotStatus.entries.filter((e) => e.status === 'created').slice(0, 50)"
                    :key="e.path"
                    class="truncate"
                  >
                    {{ e.path }}
                  </div>
                </div>
                <div v-if="snapshotStatus.entries.filter((e) => e.status === 'excluded').length > 0" class="mb-2">
                  <div class="font-medium text-muted-foreground">Xung đột (không thao tác):</div>
                  <div
                    v-for="e in snapshotStatus.entries.filter((e) => e.status === 'excluded').slice(0, 50)"
                    :key="e.path"
                    class="truncate"
                  >
                    {{ e.path }}
                  </div>
                </div>
              </div>

              <div class="flex justify-end gap-2">
                <button
                  type="button"
                  class="px-3 py-1 text-muted-foreground hover:text-foreground"
                  @click="workspaceRevertConfirm = false"
                >
                  hủy
                </button>
                <button
                  type="button"
                  class="rounded-md bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50"
                  :disabled="!canApplyPlan(snapshotStatus).ok"
                  @click="doRevertWorkspace"
                >
                  Xác nhận khôi phục
                </button>
              </div>
            </div>
          </div>
        </template>
      </template>

      <!-- Diagnostics -->
      <template v-else>
        <div class="mb-2 flex items-center justify-between gap-2 text-muted-foreground">
          <span>cấu hình runner</span>
          <button type="button" class="text-primary hover:underline" @click="loadDiagnostics">
            làm mới
          </button>
        </div>

        <p v-if="diagnosticsLoading" class="text-muted-foreground">Đang tải…</p>
        <p v-else-if="diagnosticsError !== null" class="text-destructive">
          {{ diagnosticsError }}
        </p>

        <dl v-else-if="diagnostics !== null" class="grid gap-1.5">
          <template v-for="source in diagnostics.report.sources" :key="source.source">
            <div class="flex items-baseline justify-between gap-3">
              <dt class="text-muted-foreground">{{ source.source }}</dt>
              <dd class="truncate" :title="source.path">
                {{ source.exists ? (source.readable ? "đọc được" : "không đọc được") : "không có" }}
              </dd>
            </div>
          </template>
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-muted-foreground">git</dt>
            <dd>{{ diagnostics.report.gitAvailable ? "có" : "không" }}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-muted-foreground">provider auth</dt>
            <dd>{{ diagnostics.report.providerAuth }}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-muted-foreground">runtime</dt>
            <dd>{{ diagnostics.report.runtime }}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-muted-foreground">workspace root</dt>
            <dd class="truncate" :title="diagnostics.report.workspaceRoot">
              {{ diagnostics.report.workspaceRoot }}
            </dd>
          </div>
        </dl>

        <ul v-if="diagnostics?.report.warnings.length" class="mt-2 grid gap-1">
          <li
            v-for="warning in diagnostics.report.warnings"
            :key="warning"
            class="rounded-md border border-border/60 bg-background/60 px-2 py-1.5"
          >
            {{ warning }}
          </li>
        </ul>
      </template>
    </div>
  </aside>
</template>
