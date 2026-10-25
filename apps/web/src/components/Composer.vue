<script setup lang="ts">
import { ArrowUp, FolderOpen, GitBranch, Paperclip, Server, Shield, Square, X } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
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
import { cancelRun, startRun } from "../services/runs-api";

/**
 * The prompt box (§16.1). On the new-session page (sessionId null) it mints
 * the session id itself — a session exists the moment its first run does —
 * and tells the view, which opens the journal the run will stream into.
 *
 * The toolbar mirrors the desktop composer: context selectors above, the
 * prompt in the middle, actions below. The context row belongs to the
 * new-session screen alone — an existing session already fixed its
 * runner/project/branch when it was created. Only some of it travels today:
 * the project select is the dispatch body's workspaceId; the runner
 * preference and branch/model/permission stay in this tab until the API
 * grows (§11.3 still places runs on the first ready runner).
 */

const props = defineProps<{
  /** Null on the new-session page: the composer mints the id itself. */
  sessionId: string | null;
  /** The run currently in flight, when there is one to stop. */
  activeRunId?: string | null;
}>();

const emit = defineEmits<{ started: [sessionId: string, runId: string] }>();

const prompt = ref("");
const sending = ref(false);

const runnerId = ref("auto");
const project = ref("default");
const branch = ref("main");
const permission = ref("default");
const model = ref("default");

const permissionLabels: Record<string, string> = {
  default: "Hỏi từng lệnh",
  acceptEdits: "Tự chấp nhận sửa file",
  plan: "Chỉ lập kế hoạch",
  bypassPermissions: "Toàn quyền",
};
const modelLabels: Record<string, string> = {
  default: "Mặc định",
  sonnet: "Sonnet",
  opus: "Opus",
  haiku: "Haiku",
};

/** The runner list is advisory: picking one does not override §11.3 placement. */
const runners = ref<Array<{ runnerId: string }>>([]);

onMounted(() => {
  void (async () => {
    const response = await fetch("/api/runners");
    if (!response.ok) return;
    const body = (await response.json()) as {
      runners: Array<{ runnerId: string; revokedAt: number | null }>;
    };
    runners.value = body.runners.filter((r) => r.revokedAt === null);
  })();
});

const canSend = computed(() => prompt.value.trim() !== "" && !sending.value);

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
  // workspaceId rides along only where its selector lives: the new-session
  // screen. An existing session keeps the workspace it was created with.
  const workspaceId = props.sessionId === null ? project.value : undefined;
  const result = await startRun(sessionId, prompt.value.trim(), workspaceId);
  sending.value = false;

  if (result.ok) {
    prompt.value = "";
    attachments.value = [];
    toast.success("Đã gửi prompt — run đang tới runner.");
    emit("started", sessionId, result.runId);
    return;
  }
  if (result.reason === "session_busy") {
    toast.error("Phiên đang có run — hãy đợi run hiện tại kết thúc.");
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
  <InputGroup class="bg-card shadow-sm">
    <InputGroupAddon v-if="sessionId === null" align="block-start" class="gap-1.5">
      <Select v-model="runnerId">
        <SelectTrigger
          size="sm"
          aria-label="Chọn runner"
          class="h-7 gap-1.5 rounded-lg border-transparent bg-transparent px-2 text-xs font-medium text-muted-foreground hover:bg-muted"
        >
          <Server :size="13" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="auto">Tự động</SelectItem>
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
      <Select v-model="project">
        <SelectTrigger
          size="sm"
          aria-label="Chọn project"
          class="h-7 gap-1.5 rounded-lg border-transparent bg-transparent px-2 text-xs font-medium text-muted-foreground hover:bg-muted"
        >
          <FolderOpen :size="13" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="default" class="font-mono text-xs">default</SelectItem>
        </SelectContent>
      </Select>
      <Select v-model="branch">
        <SelectTrigger
          size="sm"
          aria-label="Chọn branch"
          class="h-7 gap-1.5 rounded-lg border-transparent bg-transparent px-2 text-xs font-medium text-muted-foreground hover:bg-muted"
        >
          <GitBranch :size="13" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="main" class="font-mono text-xs">main</SelectItem>
        </SelectContent>
      </Select>
    </InputGroupAddon>

    <InputGroupTextarea
      v-model="prompt"
      rows="3"
      class="max-h-52 px-4 py-3 text-[13px] leading-relaxed"
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

    <InputGroupAddon align="block-end" class="justify-between border-t border-border pt-2 pb-2">
      <div class="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Đính kèm tệp"
          title="Đính kèm tệp"
          class="text-muted-foreground"
          @click="pickFiles"
        >
          <Paperclip :size="15" />
        </Button>
        <input ref="fileInput" type="file" multiple class="hidden" @change="onFilesPicked" />
        <Select v-model="permission">
          <SelectTrigger
            size="sm"
            aria-label="Chọn quyền của run"
            class="h-7 gap-1.5 rounded-lg border-transparent bg-transparent px-2 text-xs font-medium text-muted-foreground hover:bg-muted"
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
            class="h-7 gap-1.5 rounded-lg border-transparent bg-transparent px-2 text-xs font-medium text-muted-foreground hover:bg-muted"
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
          class="rounded-full"
          :disabled="!canSend"
          @click="send"
        >
          <ArrowUp :size="15" />
        </Button>
      </div>
    </InputGroupAddon>
  </InputGroup>
</template>
