<script setup lang="ts">
import type {
  DiagnosticsResult,
  FileListResult,
  FileReadResult,
  GitChangesResult,
  GitDiffResult,
} from "@cc-web/protocol";
import { computed, ref, watch } from "vue";
import { classifyDiffLines } from "../features/inspect/diff";
import { formatSize } from "../features/inspect/format";
import { breadcrumbs, joinPath, parentPath } from "../features/inspect/paths";
import {
  compositeId,
  fetchChanges,
  fetchDiagnostics,
  fetchDiff,
  listFiles,
  readFile,
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
  if (row?.runnerId === null || row?.workspaceId === null || row === undefined) return null;
  return compositeId(row.runnerId, row.workspaceId);
});

// Files
const directory = ref("");
const listing = ref<FileListResult | null>(null);
const filesError = ref<string | null>(null);
const filesLoading = ref(false);
const viewer = ref<FileReadResult | null>(null);

// Changes
const changes = ref<GitChangesResult | null>(null);
const changesError = ref<string | null>(null);
const changesLoading = ref(false);
const diff = ref<GitDiffResult | null>(null);
const diffPath = ref<string | null>(null);

// Diagnostics
const diagnostics = ref<DiagnosticsResult | null>(null);
const diagnosticsError = ref<string | null>(null);
const diagnosticsLoading = ref(false);

const crumbs = computed(() => breadcrumbs(directory.value));
const diffLines = computed(() => (diff.value === null ? [] : classifyDiffLines(diff.value.diff)));
const breadcrumbPrefix = computed(() => [...crumbs.value]);

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
  filesLoading.value = true;
  filesError.value = null;
  viewer.value = null;
  const outcome = await listFiles(id, dir);
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
  changesLoading.value = true;
  changesError.value = null;
  diff.value = null;
  diffPath.value = null;
  const outcome = await fetchChanges(id);
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
  diagnosticsLoading.value = true;
  diagnosticsError.value = null;
  const outcome = await fetchDiagnostics(id);
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

  filesLoading.value = true;
  filesError.value = null;
  const outcome = await readFile(id, path);
  filesLoading.value = false;
  if (!outcome.ok) {
    filesError.value = outcome.message;
    viewer.value = null;
    return;
  }
  viewer.value = outcome.value;
}

async function openDiff(path: string): Promise<void> {
  const id = workspace.value;
  if (id === null) return;
  const outcome = await fetchDiff(id, path);
  if (!outcome.ok) {
    changesError.value = outcome.message;
    return;
  }
  diff.value = outcome.value;
  diffPath.value = path;
}

function goUp(): void {
  const parent = parentPath(directory.value);
  if (parent !== undefined) void loadFiles(parent);
}

// A different session is a different workspace: drop everything the previous
// one showed rather than presenting its contents under a new header.
watch(
  () => [props.sessionId, workspace.value] as const,
  () => {
    directory.value = "";
    listing.value = null;
    viewer.value = null;
    filesError.value = null;
    changes.value = null;
    changesError.value = null;
    diff.value = null;
    diffPath.value = null;
    diagnostics.value = null;
    diagnosticsError.value = null;
    if (workspace.value !== null) void loadFiles("");
  },
  { immediate: true },
);

watch(tab, (next) => {
  if (workspace.value === null) return;
  if (next === "files" && listing.value === null) void loadFiles(directory.value);
  if (next === "changes" && changes.value === null) void loadChanges();
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
          <template v-for="crumb in breadcrumbPrefix" :key="crumb.path">
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
          <pre
            v-if="viewer.content !== null"
            class="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-background/60 p-2"
            >{{ viewer.content }}</pre
          >
          <p v-else class="text-muted-foreground">Không có nội dung để hiển thị.</p>
        </template>

        <template v-else-if="listing !== null">
          <div class="mb-1.5 flex items-center justify-between gap-2 text-muted-foreground">
            <span>{{ listing.entries.length }} mục</span>
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
            <li v-for="entry in listing.entries" :key="entry.name">
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
          <p v-if="listing.entries.length === 0" class="text-muted-foreground">
            Thư mục trống.
          </p>
        </template>
      </template>

      <!-- Changes -->
      <template v-else-if="tab === 'changes'">
        <div class="mb-2 flex items-center justify-between gap-2 text-muted-foreground">
          <span>{{ changes?.entries.length ?? 0 }} thay đổi</span>
          <button type="button" class="text-primary hover:underline" @click="loadChanges">
            làm mới
          </button>
        </div>

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
          <p
            v-if="changes.truncated"
            class="mb-2 rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-muted-foreground"
          >
            Danh sách đã được rút gọn — hiển thị 2000 thay đổi đầu tiên.
          </p>
          <ul class="grid gap-0.5">
            <li v-for="entry in changes.entries" :key="entry.path">
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
          <p v-if="changes.entries.length === 0" class="text-muted-foreground">
            Working tree sạch — không có thay đổi nào.
          </p>
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
