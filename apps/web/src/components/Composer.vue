<script setup lang="ts">
import type { ModelId, SessionSummary } from "@cc-web/protocol";
import {
  ArrowUp,
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
import { relativeTime } from "@/lib/relative-time.ts";
import { authFetch } from "../services/auth-api";
import { cancelRun, startRun } from "../services/runs-api";
import { fetchWorkspaces, type OwnerWorkspace } from "../services/workspaces-api";
import FolderBrowserModal from "./FolderBrowserModal.vue";

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
 * ready runner"), pick a folder on that runner (a workspace it already
 * declared, or one found through the directory browser, which registers it so
 * its Claude Code sessions become addressable), then pick a session in that
 * folder or start a new one. The branch is information, not a choice: the chip
 * shows the branch the folder's HEAD was on at the runner's last declaration,
 * the run sends no branch, and the workspace runs on whatever HEAD it holds.
 */

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  /** Null on the new-session page: the composer mints the id itself. */
  sessionId: string | null;
  /** The run currently in flight, when there is one to stop. */
  activeRunId?: string | null;
}>();

const emit = defineEmits<{
  started: [sessionId: string, runId: string, promptText?: string];
}>();

const prompt = ref("");
const sending = ref(false);

/** The chosen runner; empty until the operator picks one. */
const runnerId = ref("");
/** The chosen folder's composite id, or empty until a folder is picked. */
const folderKey = ref("");
const permission = ref("default");
const model = ref("default");

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
// Keyed by ModelId: a name added to the protocol's MODEL_IDS list without a
// label here is a type error, so the dropdown can never drift from the route's
// validation set.
const modelIdLabels: Record<ModelId, string> = {
  sonnet: "Sonnet",
  opus: "Opus",
  haiku: "Haiku",
};
const modelLabels: Record<string, string> = {
  default: "Mặc định",
  ...modelIdLabels,
};

/** The runners the operator chooses from — no run is placed without a choice. */
const runners = ref<Array<{ runnerId: string }>>([]);
const workspaces = ref<OwnerWorkspace[]>([]);

onMounted(() => {
  void (async () => {
    const response = await authFetch("/api/runners");
    if (!response.ok) return;
    const body = (await response.json()) as {
      runners: Array<{ runnerId: string; revokedAt: number | null }>;
    };
    runners.value = body.runners.filter((r) => r.revokedAt === null);
  })();
  void refreshWorkspaces();
});

/**
 * One folder the chosen runner offers. The value is the composite
 * `${runnerId}/${workspaceId}` — UUIDs contain no `/`, so it round-trips.
 */
type FolderOption = {
  value: string;
  workspaceId: string;
  runnerId: string;
  path: string;
  /** The branch HEAD was on at the last declaration; null when unknown. */
  currentBranch: string | null;
};

/**
 * The folders the chosen runner serves (§15.1). Empty until a runner is
 * picked: the operator names the runner first, so no order of picking can
 * dispatch a run onto a runner they did not choose.
 */
const folderOptions = computed<FolderOption[]>(() => {
  if (runnerId.value === "") return [];
  return workspaces.value
    .filter((w) => w.runnerId === runnerId.value)
    .map((w) => ({
      value: `${w.runnerId}/${w.workspaceId}`,
      workspaceId: w.workspaceId,
      runnerId: w.runnerId,
      path: w.path,
      // An older control server serves this row without the field; the chip
      // then simply stays hidden.
      currentBranch: w.currentBranch ?? null,
    }));
});

const selectedFolder = computed(() => folderOptions.value.find((o) => o.value === folderKey.value));

// A folder that falls out of the option list — a re-declaration dropped it, or
// the runner changed — clears the selection rather than silently pointing the
// send button at a folder the select no longer holds.
watch(folderOptions, () => {
  if (!folderOptions.value.some((o) => o.value === folderKey.value)) {
    folderKey.value = "";
  }
});

// The runner owns the folder list: switching runners drops the folder and the
// session picked under the old one. Loading the new runner's declarations is
// the same fetch that keeps the list fresh.
watch(runnerId, () => {
  folderKey.value = "";
  void refreshWorkspaces();
});

async function refreshWorkspaces(): Promise<void> {
  const result = await fetchWorkspaces();
  if (result.ok) workspaces.value = result.workspaces;
}

// On the new-session page, choosing a folder (or a refresh that keeps it)
// re-discovers that folder's Claude Code sessions. A response for a folder
// that is no longer selected is dropped, so a slow first fetch cannot paint
// over the second folder's list.
let sessionsEpoch = 0;
watch(
  [selectedFolder, () => props.sessionId],
  ([option, currentSessionId]) => {
    if (currentSessionId !== null) return; // sessions are fixed for an existing session
    if (option === undefined) {
      sessionsEpoch++;
      workspaceSessions.value = null;
      selectedSession.value = NEW_SESSION;
      return;
    }
    const epoch = ++sessionsEpoch;
    void (async () => {
      const result = await loadWorkspaceSessions(option.workspaceId, option.runnerId);
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
    folderKey.value = `${known.runnerId}/${known.workspaceId}`;
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
  // The control plane wrote the row, so it is addressable right away; mirror
  // it locally instead of refetching the whole declaration.
  workspaces.value = [
    ...workspaces.value,
    {
      workspaceId: result.workspaceId,
      runnerId: runner,
      path,
      branches: [],
      currentBranch: null,
      createdAt: Date.now(),
    },
  ];
  folderKey.value = result.compositeId;
}

/** The new-session page cannot send before a folder names where the run goes. */
const needsFolder = computed(() => props.sessionId === null && selectedFolder.value === undefined);

const canSend = computed(() => prompt.value.trim() !== "" && !sending.value && !needsFolder.value);

/** The permission selector warns while the run would skip every gate. */
const permissionTone = computed(() =>
  permission.value === "bypassPermissions"
    ? "text-amber-600 dark:text-amber-500"
    : "text-muted-foreground",
);

// Attachments are local for now — the run surface has no upload yet, so the
// chips say "picked", the toast says "not sent", and a successful send
// clears them instead of pretending they reached the runner.
const attachments = ref<File[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);

function pickFiles(): void {
  fileInput.value?.click();
}

function onFilesPicked(event: Event): void {
  const input = event.target as HTMLInputElement;
  for (const file of input.files ?? []) attachments.value.push(file);
  input.value = "";
  if (attachments.value.length > 0) {
    toast.info("Tệp được chọn nhưng chưa gửi được — runner chưa hỗ trợ đính kèm.");
  }
}

function dropFile(index: number): void {
  attachments.value.splice(index, 1);
}

async function send(): Promise<void> {
  if (!canSend.value) return;
  sending.value = true;
  const sessionId = props.sessionId ?? crypto.randomUUID();
  const folder = selectedFolder.value;
  const body = buildRunRequest({
    prompt: prompt.value,
    permission: permission.value,
    model: model.value,
    workspaceId: folder?.workspaceId,
    projectRunnerId: folder?.runnerId,
    runnerId: runnerId.value,
    selectedSession: selectedSession.value,
    isNewSessionPage: props.sessionId === null,
  });
  const promptText = prompt.value;
  const result = await startRun(sessionId, body);

  if (result.ok) {
    prompt.value = "";
    attachments.value = [];
    emit("started", sessionId, result.runId, promptText);
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
  <InputGroup class="gap-0 bg-card shadow-sm" v-bind="$attrs">
    <InputGroupAddon
      v-if="sessionId === null"
      align="block-start"
      class="gap-1.5 px-3.5 pt-2.5 pb-0"
    >
      <Select v-model="runnerId">
        <SelectTrigger
          size="sm"
          aria-label="Chọn runner"
          class="h-7! gap-1.5 rounded-lg border-transparent bg-transparent px-2 text-xs font-medium text-muted-foreground hover:bg-muted"
        >
          <Server :size="13" />
          <SelectValue placeholder="Chọn runner" />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem
            v-for="r in runners"
            :key="r.runnerId"
            :value="r.runnerId"
            class="max-w-[300px] font-mono text-xs"
          >
            {{ r.runnerId }}
          </SelectItem>
        </SelectContent>
      </Select>
      <Select v-model="folderKey" :disabled="runnerId === ''">
        <SelectTrigger
          size="sm"
          aria-label="Chọn folder"
          class="h-7! gap-1.5 rounded-lg border-transparent bg-transparent px-2 text-xs font-medium text-muted-foreground hover:bg-muted"
        >
          <FolderOpen :size="13" />
          <span v-if="selectedFolder" class="max-w-[220px] truncate font-mono text-xs">
            {{ selectedFolder.path }}
          </span>
          <span v-else class="text-xs">Chọn folder</span>
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem
            v-for="option in folderOptions"
            :key="option.value"
            :value="option.value"
            class="max-w-[360px]"
          >
            <span class="max-w-[300px] truncate font-mono text-xs">{{ option.path }}</span>
          </SelectItem>
        </SelectContent>
      </Select>
      <Button
        v-if="runnerId !== ''"
        variant="ghost"
        size="sm"
        class="h-7! gap-1 border-transparent bg-transparent px-2 text-xs font-medium text-muted-foreground hover:bg-muted"
        aria-label="Duyệt thư mục trên runner"
        title="Duyệt thư mục trên runner..."
        @click="browserOpen = true"
      >
        <FolderGit2 :size="13" />
        Duyệt…
      </Button>
      <Select v-model="selectedSession" :disabled="!workspaceSessions">
        <SelectTrigger
          size="sm"
          aria-label="Chọn session"
          class="h-7! gap-1.5 rounded-lg border-transparent bg-transparent px-2 text-xs font-medium text-muted-foreground hover:bg-muted"
        >
          <History :size="13" />
          <SelectValue />
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
      <span
        v-if="selectedFolder?.currentBranch"
        class="flex h-7 items-center gap-1.5 px-2 text-xs text-muted-foreground"
        :title="`Branch hiện tại: ${selectedFolder.currentBranch}`"
      >
        <GitBranch :size="13" />
        <span class="max-w-[160px] truncate font-mono">{{ selectedFolder.currentBranch }}</span>
      </span>
    </InputGroupAddon>

    <InputGroupTextarea
      v-model="prompt"
      class="max-h-52 min-h-12 px-3.5 py-2.5 text-[13px] leading-relaxed"
      placeholder="Gửi prompt cho runner…"
      aria-label="Ô soạn prompt"
      @keydown.enter.exact.prevent="send"
    />

    <div v-if="attachments.length > 0" class="flex flex-wrap gap-1.5 px-3.5 pb-1">
      <span
        v-for="(file, i) in attachments"
        :key="`${file.name}-${i}`"
        class="flex h-6 items-center gap-0.5 rounded-md border border-border bg-muted pr-0.5 pl-2 font-mono text-[11px] text-muted-foreground"
      >
        <span class="max-w-[180px] truncate">{{ file.name }}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          class="size-4"
          :aria-label="`Bỏ ${file.name}`"
          @click="dropFile(i)"
        >
          <X :size="11" />
        </Button>
      </span>
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
        <input ref="fileInput" type="file" multiple class="hidden" @change="onFilesPicked" />
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
        <Select v-model="model">
          <SelectTrigger
            size="sm"
            aria-label="Chọn model"
            class="h-7! gap-1.5 rounded-lg border-transparent bg-transparent px-2 text-xs font-medium text-muted-foreground hover:bg-muted"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem v-for="(label, value) in modelLabels" :key="value" :value="value">
              {{ label }}
            </SelectItem>
          </SelectContent>
        </Select>
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
