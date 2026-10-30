<script setup lang="ts">
import { Pencil, Trash2 } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { toast } from "vue-sonner";
import ConfirmDeleteDialog from "@/components/ConfirmDeleteDialog.vue";
import RenameDialog from "@/components/RenameDialog.vue";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { authFetch } from "@/services/auth-api.ts";
import { deleteRunner, renameRunner } from "@/services/runners-api.ts";
import { removeSession } from "@/stores/sessions.ts";

/**
 * The runners console (§6.1): the owner's connectors and the one-time token
 * a new one is set up with. The token exists in this component's state and in
 * the mint response alone — the server kept only its hash, and nothing here
 * writes it anywhere a reload could recover.
 */

type RunnerRow = {
  runnerId: string;
  name?: string | null;
  createdAt: number;
  revokedAt: number | null;
};

const runners = ref<RunnerRow[]>([]);
const minted = ref<{ runnerId: string; token: string } | null>(null);
const mintBusy = ref(false);
/** The row awaiting a second click — revocation is not undoable, so it asks. */
const confirming = ref<string | null>(null);
const revokeBusy = ref(false);
const origin = location.origin;

const runnerToRename = ref<RunnerRow | null>(null);
const renameDialogOpen = ref(false);

const runnerToDelete = ref<RunnerRow | null>(null);
const deleteDialogOpen = ref(false);
const deleteBusy = ref(false);

/** The journal's numbering: the newest runner is event 0001. */
const mintedSeq = computed(() => {
  if (minted.value === null) return "";
  const index = runners.value.findIndex((r) => r.runnerId === minted.value?.runnerId);
  return String(index + 1).padStart(4, "0");
});

const setupCommands = computed(() => {
  if (minted.value === null) return "";
  return [
    `CC_WEB_RUNNER_TOKEN=<token phía trên> cc-web-runner setup \\`,
    `  --server ${origin} --runner-id ${minted.value.runnerId}`,
    ``,
    `cc-web-runner connect   # hoặc: cc-web-runner service install`,
  ].join("\n");
});

function pad(n: number): string {
  return String(n).padStart(4, "0");
}

function fmt(ms: number): string {
  return new Date(ms).toLocaleString("vi-VN", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function load(): Promise<void> {
  const response = await authFetch("/api/runners");
  if (!response.ok) {
    toast.error(await response.text());
    return;
  }
  runners.value = ((await response.json()) as { runners: RunnerRow[] }).runners;
}

async function mint(): Promise<void> {
  mintBusy.value = true;
  try {
    const response = await authFetch("/api/runners", { method: "POST" });
    if (!response.ok) {
      toast.error(await response.text());
      return;
    }
    minted.value = (await response.json()) as { runnerId: string; token: string };
    await load();
  } finally {
    mintBusy.value = false;
  }
}

async function copyToken(): Promise<void> {
  if (minted.value === null) return;
  try {
    await navigator.clipboard.writeText(minted.value.token);
    toast.success("Đã sao chép token.");
  } catch {
    toast.error("Không sao chép được token — chọn và sao chép thủ công.");
  }
}

function triggerRename(runner: RunnerRow): void {
  runnerToRename.value = runner;
  renameDialogOpen.value = true;
}

async function handleRenameConfirm(newName: string): Promise<void> {
  if (!runnerToRename.value) return;
  const runner = runnerToRename.value;
  const ok = await renameRunner(runner.runnerId, newName);
  if (ok) {
    runner.name = newName.trim() || null;
    toast.success("Đã đổi tên runner.");
  } else {
    toast.error("Không thể đổi tên runner.");
  }
  runnerToRename.value = null;
}

function triggerDelete(runner: RunnerRow): void {
  runnerToDelete.value = runner;
  deleteDialogOpen.value = true;
}

async function handleDeleteConfirm(): Promise<void> {
  if (!runnerToDelete.value) return;
  const runner = runnerToDelete.value;
  deleteBusy.value = true;
  try {
    const result = await deleteRunner(runner.runnerId);
    if (result.ok) {
      runners.value = runners.value.filter((r) => r.runnerId !== runner.runnerId);
      if (result.deletedSessions && result.deletedSessions.length > 0) {
        for (const sid of result.deletedSessions) {
          removeSession(sid);
        }
      }
      toast.success("Đã xoá runner.");
    } else {
      toast.error("Không thể xoá runner.");
    }
  } finally {
    deleteBusy.value = false;
    deleteDialogOpen.value = false;
    runnerToDelete.value = null;
  }
}

/**
 * Revoke a runner (§17). Irreversible — the credential is killed and a
 * reconnect with the same token fails closed — so the first click only arms
 * the row and the second performs it.
 */
async function revoke(runnerId: string): Promise<void> {
  if (confirming.value !== runnerId) {
    confirming.value = runnerId;
    return;
  }
  revokeBusy.value = true;
  try {
    const response = await authFetch(`/api/runners/${encodeURIComponent(runnerId)}/revoke`, {
      method: "POST",
    });
    if (!response.ok) {
      toast.error(await response.text());
      return;
    }
    toast.success("Đã thu hồi runner");
    await load();
  } finally {
    revokeBusy.value = false;
    confirming.value = null;
  }
}

onMounted(() => void load());
</script>

<template>
  <ScrollArea class="min-h-0 flex-1">
    <div class="mx-auto w-full max-w-[720px] px-7 py-7">
      <p class="mb-6 flex items-center gap-3.5 font-mono text-[13px] text-primary">
        cc-web / runners
        <span class="h-px flex-1 bg-border" aria-hidden="true" />
      </p>
      <h1 class="mb-2 text-[26px] font-medium tracking-tight">Kết nối Runner.</h1>
      <p class="mb-6 text-sm leading-relaxed text-muted-foreground">
        Runner là connector chạy trên máy chứa dự án của bạn: nó tự kết nối ra
        server này, nhận lệnh, và ghi lại những gì agent đã làm vào journal.
      </p>

      <div class="mb-6 flex">
        <Button :disabled="mintBusy" @click="mint">Thêm runner</Button>
      </div>

      <!-- The journal's newest event: sequence gutter, one-time payload. -->
      <section v-if="minted" class="grid grid-cols-[76px_1fr] gap-x-3.5 border-t border-border py-4">
        <span class="select-all pr-4.5 text-right font-mono text-xs leading-6 text-muted-foreground" aria-hidden="true">
          {{ mintedSeq }}
        </span>
        <div class="grid gap-3.5">
          <p class="text-sm font-medium">Token runner dùng một lần</p>
          <p class="text-[13px] text-muted-foreground">
            Chỉ hiển thị một lần — server chỉ lưu hash của nó. Hãy sao chép ngay bây giờ.
          </p>
          <div class="flex items-center gap-3 rounded-md border border-border bg-muted px-3 py-2.5">
            <span class="min-w-0 flex-1 break-all font-mono text-[13px] select-all">{{ minted.token }}</span>
            <Button
              variant="outline"
              size="xs"
              class="shrink-0"
              @click="copyToken"
            >
              sao chép
            </Button>
          </div>
          <div class="grid gap-1">
            <span class="font-mono text-xs tracking-wider text-muted-foreground uppercase">mã runner</span>
            <span class="break-all font-mono text-[13px] select-all">{{ minted.runnerId }}</span>
          </div>
          <pre class="whitespace-pre-wrap break-all rounded-md border-l-2 border-border px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed text-muted-foreground">{{ setupCommands }}</pre>
          <Button variant="outline" size="sm" class="justify-self-start" @click="minted = null">
            Xong
          </Button>
        </div>
      </section>

      <p
        v-if="runners.length === 0 && minted === null"
        class="mt-7 border-t border-border pt-4 text-sm text-muted-foreground"
      >
        Chưa có runner nào. Mint một token rồi chạy lệnh setup trên máy đó.
      </p>

      <div
        v-for="(runner, i) in runners"
        :key="runner.runnerId"
        class="grid grid-cols-[76px_1fr] gap-x-3.5 border-t border-border py-3 transition-colors hover:bg-muted/50"
      >
        <span
          class="select-all pr-4.5 text-right font-mono text-xs leading-6 text-muted-foreground"
          :title="new Date(runner.createdAt).toISOString()"
        >
          {{ pad(i + 1) }}
        </span>
        <div class="flex min-w-0 items-center gap-3">
          <div class="grid min-w-0 flex-1 gap-0.5">
            <div class="flex items-center gap-2">
              <span
                class="truncate text-sm"
                :class="runner.name ? 'font-medium text-foreground' : 'font-mono text-[13px]'"
              >
                {{ runner.name || runner.runnerId }}
              </span>
              <span
                v-if="runner.name"
                class="truncate font-mono text-xs text-muted-foreground"
              >
                ({{ runner.runnerId }})
              </span>
            </div>
            <span class="font-mono text-xs text-muted-foreground">
              đã kết nối {{ fmt(runner.createdAt) }}
              <template v-if="runner.revokedAt !== null"> · đã thu hồi {{ fmt(runner.revokedAt) }}</template>
            </span>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <Button
              variant="ghost"
              size="icon-xs"
              title="Đổi tên runner"
              class="text-muted-foreground hover:text-foreground"
              @click="triggerRename(runner)"
            >
              <Pencil :size="14" />
            </Button>
            <Button
              v-if="runner.revokedAt === null"
              variant="outline"
              size="xs"
              class="shrink-0"
              :disabled="revokeBusy"
              @click="revoke(runner.runnerId)"
            >
              {{ confirming === runner.runnerId ? "chắc chắn?" : "thu hồi" }}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              title="Xoá runner"
              class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              @click="triggerDelete(runner)"
            >
              <Trash2 :size="14" />
            </Button>
          </div>
        </div>
      </div>
    </div>

    <RenameDialog
      v-model:open="renameDialogOpen"
      title="Đổi tên runner"
      description="Đặt tên gợi nhớ cho runner này để dễ dàng nhận biết."
      :initial-value="runnerToRename?.name || ''"
      placeholder="Nhập tên runner..."
      @confirm="handleRenameConfirm"
    />

    <ConfirmDeleteDialog
      v-model:open="deleteDialogOpen"
      title="Xoá runner"
      :description="runnerToDelete?.name ? `Bạn có chắc chắn muốn xoá runner “${runnerToDelete.name}” (${runnerToDelete.runnerId})?` : `Bạn có chắc chắn muốn xoá runner ${runnerToDelete?.runnerId}?`"
      :warning="runnerToDelete?.revokedAt !== null ? 'Xoá runner này sẽ xoá vĩnh viễn dữ liệu runner cùng toàn bộ phiên làm việc, lượt chạy liên quan khỏi hệ thống.' : 'Runner này đang hoạt động. Việc xoá sẽ ngắt kết nối ngay lập tức và xoá vĩnh viễn runner cùng toàn bộ phiên làm việc, lượt chạy liên quan.'"
      confirm-label="Xoá runner"
      :busy="deleteBusy"
      @confirm="handleDeleteConfirm"
    />
  </ScrollArea>
</template>
