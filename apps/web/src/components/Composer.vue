<script setup lang="ts">
import type { AttachmentInfo, EffortLevel, RunnerModel, SessionSummary } from "@cc-web/protocol";
import {
  ArrowUp,
  FileImage,
  FolderGit2,
  FolderOpen,
  GitBranch,
  History,
  Paperclip,
  Server,
  Shield,
  Square,
  X,
} from "@lucide/vue";
import { computed, onMounted, ref, watch } from "vue";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  buildRunRequest,
  loadWorkspaceSessions,
  NEW_SESSION,
  registerCustomWorkspace,
  workspaceForPath,
} from "@/features/composer/composer-logic.ts";
import {
  loadComposerSettings,
  saveComposerSettings,
} from "@/features/composer/composer-storage.ts";
import {
  effortLevelsFor,
  modelFor,
  normalizeEffort,
  pickerModels,
} from "@/features/composer/model-picker.ts";
import { shortRunnerId } from "@/features/sessions/folder-tree.ts";
import { relativeTime } from "@/lib/relative-time.ts";
import { uploadSessionAttachments } from "../services/attachments-api";
import {
  fetchRunners,
  liveRunners,
  modelsOfRunner,
  type OwnerRunner,
} from "../services/runners-api";
import { cancelRun, startRun } from "../services/runs-api";
import { fetchWorkspaces, type OwnerWorkspace } from "../services/workspaces-api";
import { sessions } from "../stores/sessions.ts";
import FolderBrowserModal from "./FolderBrowserModal.vue";
import ModelPickerPopover from "./ModelPickerPopover.vue";

/**
 * The prompt box (§16.1). On the new-session page (sessionId null) it mints
 * the session id itself — a session exists the moment its first run does —
 * and tells the view, which opens the journal the run will stream into.
 *
 * The toolbar mirrors the desktop composer: context selectors above, the
 * prompt in the middle, actions below. The context row belongs to the
 * new-session screen alone — an existing session already fixed its
 * runner/project when it was created. Creating a session is three explicit
 * steps: pick a runner (nothing is preselected, and no run is placed on "any
 * ready runner"), browse to a folder on that runner ("Duyệt…", the only way to
 * name a directory — the composer never offers a list of folders the control
 * plane already knew about), then pick a session in that folder or start a new
 * one. The branch is information, not a choice: the chip shows the branch the
 * folder's HEAD was on at the runner's declaration, the run sends no branch,
 * and the workspace runs on whatever HEAD it holds.
 */

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  /** Null on the new-session page: the composer mints the id itself. */
  sessionId: string | null;
  /** The run currently in flight, when there is one to stop. */
  activeRunId?: string | null;
}>();

const emit = defineEmits<{
  started: [sessionId: string, runId: string, promptText?: string, attachments?: AttachmentInfo[]];
}>();

const prompt = ref("");
const sending = ref(false);

/** The chosen runner; empty until the operator picks one. */
const runnerId = ref("");
const initialSettings = loadComposerSettings(props.sessionId ?? null);
const permission = ref(initialSettings.permission);
/** The picker's state (§5.2): model, effort, and the standing ultracode mode. */
const model = ref(initialSettings.model);
const effort = ref<EffortLevel | null>(initialSettings.effort);
const ultracode = ref(initialSettings.ultracode);

watch(
  () => props.sessionId,
  (newSessionId) => {
    const loaded = loadComposerSettings(newSessionId);
    permission.value = loaded.permission;
    model.value = loaded.model;
    effort.value = loaded.effort;
    ultracode.value = loaded.ultracode;
  },
);

watch([permission, model, effort, ultracode], ([perm, mdl, eff, ultra]) => {
  saveComposerSettings(props.sessionId ?? null, {
    permission: perm,
    model: mdl,
    effort: eff,
    ultracode: ultra,
  });
});

/** Sessions discovered for the selected workspace; null means "not loaded yet". */
const workspaceSessions = ref<SessionSummary[] | null>(null);
/**
 * The selected session id, or "new" for a fresh session. Only shown on the
 * new-session page (sessionId === null); an existing session already pinned
 * its session id when it was created.
 */
const selectedSession = ref<typeof NEW_SESSION | string>(NEW_SESSION);
/** Whether the FolderBrowserModal is open. */
const browserOpen = ref(false);

const permissionLabels: Record<string, string> = {
  default: "Hỏi từng lệnh",
  acceptEdits: "Tự chấp nhận sửa file",
  plan: "Chỉ lập kế hoạch",
  bypassPermissions: "Toàn quyền",
};
/** The runners the operator chooses from — no run is placed without a choice. */
const runners = ref<OwnerRunner[]>([]);
const workspaces = ref<OwnerWorkspace[]>([]);

onMounted(() => {
  void refreshRunners();
  void refreshWorkspaces();
});

/**
 * The runner registry, with each live runner's advertised models (§5.2).
 * A failure keeps the picker on the protocol fallback rather than emptying it.
 */
async function refreshRunners(): Promise<void> {
  const result = await fetchRunners();
  if (result.ok) runners.value = liveRunners(result.runners);
}

/**
 * Whose model lineup the picker shows: the runner being picked on the
 * new-session page, or — for an existing session — the runner its pin holds.
 * Empty until either is known, which the picker renders as the fallback list.
 */
const pickerRunnerId = computed(() => {
  if (runnerId.value !== "") return runnerId.value;
  if (props.sessionId === null) return "";
  return sessions.sessions.find((s) => s.sessionId === props.sessionId)?.runnerId ?? "";
});

/** What that runner advertised; empty means "unknown" — the picker falls back. */
const advertisedModels = computed<RunnerModel[]>(() =>
  modelsOfRunner(runners.value, pickerRunnerId.value),
);

// Switching runners (or a runner reporting a new lineup) must not leave the
// picker on a model this host never named: fall back to its first row, then
// drop an effort that row cannot honour. The route would refuse the stale
// value anyway — better to show the operator what would actually run.
watch(advertisedModels, (advertised) => {
  if (advertised.length === 0) return;
  const offered = pickerModels(advertised);
  if (modelFor(offered, model.value) === undefined) {
    model.value = offered[0]?.value ?? "default";
  }
  effort.value = normalizeEffort(effortLevelsFor(modelFor(offered, model.value)), effort.value);
});

/**
 * The folder the operator picked through the directory browser.
 *
 * There is deliberately no list of ready-made folders to choose from: the
 * composer never offers the workspaces the control plane already knows about,
 * because that silently turns "where does this run go" into "which of my
 * existing projects do I reuse". "Duyệt…" is the only way in — the operator
 * names a directory on the runner, and a folder that was never declared is
 * registered so the run and its sessions can address it by id.
 */
type ChosenFolder = {
  runnerId: string;
  workspaceId: string;
  path: string;
  /** The branch HEAD was on at the last declaration; null when unknown. */
  currentBranch: string | null;
};

const selectedFolder = ref<ChosenFolder | null>(null);

const selectedRunnerName = computed(() => {
  const found = runners.value.find((r) => r.runnerId === runnerId.value);
  return found?.name ? found.name : null;
});

const selectedSessionLabel = computed(() => {
  if (selectedSession.value === NEW_SESSION) return "Phiên mới";
  const found = workspaceSessions.value?.find((s) => s.sessionId === selectedSession.value);
  return found ? found.summary || found.sessionId : selectedSession.value;
});

// The runner owns the folder: switching runners drops the folder and the
// session picked under the old one. The declarations are re-read too, so a
// browsed path can still be matched to the workspace row that already exists
// for it instead of minting a second id for one directory.
watch(runnerId, () => {
  selectedFolder.value = null;
  void refreshWorkspaces();
});

async function refreshWorkspaces(): Promise<void> {
  const result = await fetchWorkspaces();
  if (!result.ok) return;
  workspaces.value = result.workspaces;
  // The chosen folder survives a refresh even before the declaration that
  // carries it lands; when it does, take the branch it names. The object keeps
  // its identity so the session list is not re-fetched for an equal folder.
  const current = selectedFolder.value;
  if (current === null) return;
  const fresh = workspaceForPath(result.workspaces, current.runnerId, current.path);
  if (fresh !== undefined) {
    current.currentBranch = fresh.currentBranch ?? null;
  }
}

// On the new-session page, choosing a folder (or a refresh that keeps it)
// re-discovers that folder's Claude Code sessions. A response for a folder
// that is no longer selected is dropped, so a slow first fetch cannot paint
// over the second folder's list.
let sessionsEpoch = 0;
watch(
  [selectedFolder, () => props.sessionId],
  ([folder, currentSessionId]) => {
    if (currentSessionId !== null) return; // sessions are fixed for an existing session
    if (folder === null) {
      sessionsEpoch++;
      workspaceSessions.value = null;
      selectedSession.value = NEW_SESSION;
      return;
    }
    const epoch = ++sessionsEpoch;
    void (async () => {
      const result = await loadWorkspaceSessions(folder.workspaceId, folder.runnerId);
      if (epoch !== sessionsEpoch) return;
      if (result.ok) {
        workspaceSessions.value = result.sessions;
        // Reset to "new" — the operator picks a session from the fresh list.
        selectedSession.value = NEW_SESSION;
      } else {
        workspaceSessions.value = null;
        toast.error(result.message);
      }
    })();
  },
  { immediate: true },
);

// The folder browser returned a path on the chosen runner. A folder the runner
// already declared is selected as-is; anything else is registered as a custom
// workspace so the session list can address it by id.
async function onBrowseSelect(path: string): Promise<void> {
  const runner = runnerId.value;
  if (runner === "") {
    toast.error("Chọn một runner trước khi duyệt thư mục.");
    return;
  }

  const known = workspaceForPath(workspaces.value, runner, path);
  if (known !== undefined) {
    browserOpen.value = false;
    selectFolder(known.runnerId, known.workspaceId, known.path, known.currentBranch ?? null);
    return;
  }

  const result = await registerCustomWorkspace(runner, path);
  if (!result.ok) {
    // The modal stays open: the folder is still the one the operator wants,
    // and re-browsing it to retry would only repeat the failed request.
    toast.error(result.message);
    return;
  }
  browserOpen.value = false;
  selectFolder(runner, result.workspaceId, path, null);
  // The control plane wrote the row and the runner re-declares it on its next
  // reconcile, so pick up whatever the declaration adds (branches, HEAD).
  void refreshWorkspaces();
}

/** Holds the folder a run may target; clearing it hides the session step. */
function selectFolder(
  folderRunnerId: string,
  workspaceId: string,
  path: string,
  currentBranch: string | null,
): void {
  selectedFolder.value = { runnerId: folderRunnerId, workspaceId, path, currentBranch };
}

/** The new-session page cannot send before a folder names where the run goes. */
const needsFolder = computed(() => props.sessionId === null && selectedFolder.value === null);

const canSend = computed(() => prompt.value.trim() !== "" && !sending.value && !needsFolder.value);

/** The permission selector warns while the run would skip every gate. */
const permissionTone = computed(() =>
  permission.value === "bypassPermissions"
    ? "text-amber-600 dark:text-amber-500"
    : "text-muted-foreground",
);

// Attachments: local previews (object URLs for images) plus the server-assigned
// ids once uploaded. Object URLs are revoked on drop and after upload.
type Attachment = {
  id: string;
  file: File;
  name: string;
  size: number;
  mimeType: string;
  previewUrl?: string;
};
const attachments = ref<Attachment[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const dragOver = ref(false);

/**
 * Format a byte count into a human-readable KB/MB string.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Append files to the attachments list, revoking any object URL for duplicates
 * so memory does not leak.
 */
function addFiles(files: File[]): void {
  for (const file of files) {
    const existing = attachments.value.find((a) => a.file === file);
    if (existing) continue;
    let previewUrl: string | undefined;
    if (file.type.startsWith("image/")) {
      previewUrl = URL.createObjectURL(file);
    }
    attachments.value.push({
      id: crypto.randomUUID(),
      file,
      name: file.name,
      size: file.size,
      mimeType: file.type,
      previewUrl,
    });
  }
}

function pickFiles(): void {
  fileInput.value?.click();
}

function onFilesPicked(event: Event): void {
  const input = event.target as HTMLInputElement;
  addFiles(Array.from(input.files ?? []));
  input.value = "";
}

/**
 * Extract files (including screenshots) from a clipboardData items list.
 */
function filesFromPaste(items: DataTransferItemList): File[] {
  const files: File[] = [];
  for (const item of items) {
    if (item.kind === "file") {
      const file = item.asFile();
      if (file) files.push(file);
    }
  }
  return files;
}

function onPaste(event: ClipboardEvent): void {
  if (!event.clipboardData) return;
  const files = filesFromPaste(event.clipboardData.items);
  if (files.length > 0) {
    addFiles(files);
  }
}

function onDragOver(event: DragEvent): void {
  event.preventDefault();
  event.dataTransfer!.dropEffect = "copy";
  dragOver.value = true;
}

function onDragLeave(): void {
  dragOver.value = false;
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  dragOver.value = false;
  addFiles(Array.from(event.dataTransfer?.files ?? []));
}

function dropFile(index: number): void {
  const attachment = attachments.value[index];
  if (attachment?.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
  attachments.value.splice(index, 1);
}

async function send(): Promise<void> {
  if (!canSend.value) return;
  sending.value = true;
  try {
    const sessionId = props.sessionId ?? crypto.randomUUID();
    const folder = selectedFolder.value;

    // Upload attachments first, then attach their ids to the run body.
    let uploadedAttachments: AttachmentInfo[] | undefined;
    if (attachments.value.length > 0) {
      const files = attachments.value.map((a) => a.file);
      const uploadResult = await uploadSessionAttachments(sessionId, files);
      if (!uploadResult.ok) {
        toast.error(uploadResult.message);
        return;
      }
      uploadedAttachments = uploadResult.attachments;
      // Revoke object URLs now that the files have been sent.
      for (const a of attachments.value) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
    }

    const body = buildRunRequest({
      prompt: prompt.value,
      permission: permission.value,
      model: model.value,
      effort: effort.value,
      ultracode: ultracode.value,
      workspaceId: folder?.workspaceId,
      projectRunnerId: folder?.runnerId,
      runnerId: runnerId.value,
      selectedSession: selectedSession.value,
      isNewSessionPage: props.sessionId === null,
      attachmentIds: uploadedAttachments?.map((a) => a.id),
    });
    const promptText = prompt.value;
    const result = await startRun(sessionId, body);

    if (result.ok) {
      saveComposerSettings(sessionId, {
        permission: permission.value,
        model: model.value,
        effort: effort.value,
        ultracode: ultracode.value,
      });
      prompt.value = "";
      attachments.value = [];
      emit("started", sessionId, result.runId, promptText, uploadedAttachments);
      return;
    }
    if (result.reason === "session_busy") {
      toast.error("Phiên đang có run — hãy đợi run hiện tại kết thúc.");
      return;
    }
    if (result.reason === "session_pinned") {
      toast.error("Phiên này đã ghim runner/workspace khác — không thể đổi giữa chừng.");
      return;
    }
    if (result.reason === "runner_unavailable") {
      toast.error("Chưa có runner sẵn sàng nhận run — kiểm tra trang runners.");
      return;
    }
    if (result.reason === "unauthorized") {
      toast.error("Đăng nhập đã hết hạn — hãy đăng nhập lại.");
      return;
    }
    toast.error("Không gửi được prompt — thử lại.");
  } finally {
    sending.value = false;
  }
}

async function stop(): Promise<void> {
  const runId = props.activeRunId;
  if (!runId) return;
  const outcome = await cancelRun(runId);
  if (outcome === "accepted") {
    toast.success("Đã gửi yêu cầu dừng run.");
    return;
  }
  if (outcome === "not_found") {
    toast.error("Run không còn đang chạy.");
    return;
  }
  toast.error("Không dừng được run — thử lại.");
}
</script>

<template>
  <InputGroup class="gap-0 bg-card shadow-sm items-stretch text-left" v-bind="$attrs">
    <InputGroupAddon
      v-if="sessionId === null"
      align="block-start"
      class="flex-wrap gap-1.5 px-3.5 pt-2.5 pb-0"
    >
      <!-- Bước 1: Chọn runner -->
      <Select v-model="runnerId">
        <SelectTrigger
          size="sm"
          aria-label="Chọn runner"
          class="h-7! max-w-[170px] shrink-0 gap-1.5 rounded-lg border-transparent bg-transparent px-2 text-xs font-medium text-muted-foreground hover:bg-muted"
          :title="runnerId ? (selectedRunnerName ? `${selectedRunnerName} (${runnerId})` : `Runner: ${runnerId}`) : 'Chọn runner'"
        >
          <Server :size="13" class="shrink-0" />
          <span v-if="selectedRunnerName" class="truncate font-sans font-medium text-xs text-foreground">{{ selectedRunnerName }}</span>
          <span v-else-if="runnerId" class="truncate font-mono text-xs">{{ shortRunnerId(runnerId) }}</span>
          <span v-else class="text-xs">Chọn runner</span>
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem
            v-for="r in runners"
            :key="r.runnerId"
            :value="r.runnerId"
            class="max-w-[320px] text-xs"
          >
            <div class="flex items-center gap-1.5 truncate">
              <span v-if="r.name" class="font-sans font-medium text-foreground truncate">{{ r.name }}</span>
              <span class="font-mono text-muted-foreground text-[11px] truncate" :class="{ 'text-foreground': !r.name }">
                {{ r.name ? `(${r.runnerId})` : r.runnerId }}
              </span>
            </div>
          </SelectItem>
        </SelectContent>
      </Select>

      <!-- Bước 2: Duyệt tới một thư mục trên runner đã chọn. Đây là cách duy
           nhất để chọn thư mục — composer không bày sẵn danh sách workspace. -->
      <Button
        v-if="runnerId !== ''"
        variant="ghost"
        size="sm"
        class="h-7! shrink-0 gap-1 border-transparent bg-transparent px-2 text-xs font-medium text-muted-foreground hover:bg-muted"
        aria-label="Duyệt thư mục trên runner"
        title="Duyệt thư mục trên runner..."
        @click="browserOpen = true"
      >
        <FolderGit2 :size="13" class="shrink-0" />
        Duyệt…
      </Button>

      <!-- Thư mục đã duyệt tới; bỏ chọn để duyệt lại chỗ khác -->
      <span
        v-if="selectedFolder"
        class="flex h-7 max-w-[280px] shrink-0 items-center gap-1.5 rounded-lg bg-muted/60 px-2 text-xs text-muted-foreground"
        :title="selectedFolder.path"
      >
        <FolderOpen :size="13" class="shrink-0" />
        <span class="truncate font-mono">{{ selectedFolder.path }}</span>
        <button
          type="button"
          class="shrink-0 cursor-pointer rounded p-0.5 hover:bg-background hover:text-foreground"
          aria-label="Bỏ thư mục đã chọn"
          title="Bỏ thư mục đã chọn"
          @click="selectedFolder = null"
        >
          <X :size="11" />
        </button>
      </span>

      <!-- Bước 3: Chọn phiên theo thư mục được chọn hoặc tạo mới (chỉ hiện sau khi đã chọn folder) -->
      <Select v-if="selectedFolder" v-model="selectedSession" :disabled="!workspaceSessions">
        <SelectTrigger
          size="sm"
          aria-label="Chọn session"
          class="h-7! max-w-[190px] shrink-0 gap-1.5 rounded-lg border-transparent bg-transparent px-2 text-xs font-medium text-muted-foreground hover:bg-muted"
          :title="selectedSessionLabel"
        >
          <History :size="13" class="shrink-0" />
          <span class="truncate font-mono text-xs">{{ selectedSessionLabel }}</span>
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="new" class="font-mono text-xs">Phiên mới</SelectItem>
          <SelectItem
            v-for="session in workspaceSessions"
            :key="session.sessionId"
            :value="session.sessionId"
            class="max-w-[300px]"
          >
            <span class="flex flex-col items-start">
              <span class="max-w-[280px] truncate font-mono text-xs">
                {{ session.summary || session.sessionId }}
              </span>
              <span class="font-mono text-[10px] text-muted-foreground">
                {{ relativeTime(session.lastModified) }}
              </span>
            </span>
          </SelectItem>
        </SelectContent>
      </Select>

      <!-- Thông tin branch hiện tại của folder -->
      <span
        v-if="selectedFolder?.currentBranch"
        class="flex h-7 shrink-0 items-center gap-1.5 px-2 text-xs text-muted-foreground"
        :title="`Branch hiện tại: ${selectedFolder.currentBranch}`"
      >
        <GitBranch :size="13" class="shrink-0" />
        <span class="max-w-[140px] truncate font-mono">{{ selectedFolder.currentBranch }}</span>
      </span>
    </InputGroupAddon>

    <div
      class="relative w-full text-left"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <InputGroupTextarea
        v-model="prompt"
        class="max-h-52 min-h-12 w-full px-3.5 py-2.5 text-left text-[13px] leading-relaxed"
        placeholder="Gửi prompt cho runner…"
        aria-label="Ô soạn prompt"
        @keydown.enter.exact.prevent="send"
        @paste="onPaste"
      />
      <!-- Drag & drop overlay backdrop -->
      <div
        v-if="dragOver"
        class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-background/80 backdrop-blur-sm"
      >
        <span class="text-sm font-medium text-foreground">Thả tệp vào đây để đính kèm</span>
      </div>
    </div>

    <div v-if="attachments.length > 0" class="flex w-full flex-wrap gap-2 px-3.5 pb-2">
      <div
        v-for="(att, i) in attachments"
        :key="att.id"
        class="relative flex h-20 w-20 items-center justify-center rounded-md border border-border bg-muted"
      >
        <img
          v-if="att.previewUrl"
          :src="att.previewUrl"
          :alt="att.name"
          class="h-20 w-20 rounded-md object-cover"
          loading="lazy"
        />
        <div
          v-else
          class="flex h-16 w-16 items-center justify-center"
        >
          <FileImage :size="32" class="text-muted-foreground" />
        </div>
        <div
          class="absolute bottom-0 left-0 right-0 truncate rounded-b bg-background/90 px-1 text-[9px] text-muted-foreground"
          :title="att.name"
        >
          {{ att.name }}
        </div>
        <div
          class="absolute top-0 right-0 flex items-center justify-center rounded-bl-none rounded-b-none rounded-tl rounded-tr bg-background/90"
        >
          <span class="text-[9px] text-muted-foreground">{{ formatSize(att.size) }}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          class="absolute -top-1 -right-1 size-5 rounded-full"
          :aria-label="`Xoá tệp ${att.name}`"
          title="Xoá tệp"
          @click="dropFile(i)"
        >
          <X :size="11" />
        </Button>
      </div>
    </div>

    <InputGroupAddon align="block-end" class="justify-between px-3.5 pt-2 pb-2">
      <div class="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Đính kèm tệp"
          title="Đính kèm tệp"
          class="size-7! text-muted-foreground"
          @click="pickFiles"
        >
          <Paperclip :size="15" />
        </Button>
        <input ref="fileInput" type="file" multiple class="hidden" accept="image/*,.pdf,.txt,.md,.csv,.json,.xml,.yaml,.yml,.log" @change="onFilesPicked" />
        <Select v-model="permission">
          <SelectTrigger
            size="sm"
            aria-label="Chọn quyền của run"
            class="h-7! gap-1.5 rounded-lg border-transparent bg-transparent px-2 text-xs font-medium text-muted-foreground hover:bg-muted"
          >
            <Shield :size="13" :class="permissionTone" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem
              v-for="(label, value) in permissionLabels"
              :key="value"
              :value="value"
            >
              {{ label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div class="flex items-center gap-2">
        <ModelPickerPopover
          v-model:model="model"
          v-model:effort="effort"
          v-model:ultracode="ultracode"
          :runner-id="pickerRunnerId"
          :advertised="advertisedModels"
        />
        <Button
          v-if="activeRunId"
          variant="destructive"
          size="sm"
          class="stop"
          @click="stop"
        >
          <Square data-icon="inline-start" />
          Dừng
        </Button>
        <Button
          size="icon-sm"
          aria-label="Gửi prompt"
          title="Gửi prompt (Enter)"
          class="size-7! rounded-full"
          :disabled="!canSend"
          @click="send"
        >
          <ArrowUp :size="15" />
        </Button>
      </div>
    </InputGroupAddon>
  </InputGroup>

  <FolderBrowserModal
    :open="browserOpen"
    :runner-id="runnerId"
    :initial-path="selectedFolder?.path ?? ''"
    @close="browserOpen = false"
    @select="onBrowseSelect"
  />
</template>
