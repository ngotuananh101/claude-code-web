<script setup lang="ts">
import { ArrowUp, Square } from "@lucide/vue";
import { computed, ref } from "vue";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { cancelRun, startRun } from "../services/runs-api";

/**
 * The prompt box (§16.1). On the new-session page (sessionId null) it mints
 * the session id itself — a session exists the moment its first run does —
 * and tells the view, which opens the journal the run will stream into.
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

const canSend = computed(() => prompt.value.trim() !== "" && !sending.value);

async function send(): Promise<void> {
  if (!canSend.value) return;
  sending.value = true;
  const sessionId = props.sessionId ?? crypto.randomUUID();
  const result = await startRun(sessionId, prompt.value.trim());
  sending.value = false;

  if (result.ok) {
    prompt.value = "";
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
  <div class="rounded-xl border border-border bg-card shadow-sm">
    <textarea
      v-model="prompt"
      rows="3"
      class="max-h-52 w-full resize-none rounded-t-xl bg-transparent px-4 py-3 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
      placeholder="Gửi prompt cho runner…"
      aria-label="Ô soạn prompt"
      @keydown.enter.exact.prevent="send"
    />
    <div class="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
      <span class="px-1 font-mono text-[11px] text-muted-foreground">
        Enter để gửi — Shift+Enter xuống dòng
      </span>
      <div class="flex items-center gap-2">
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
        <Button size="sm" :disabled="!canSend" @click="send">
          <ArrowUp data-icon="inline-start" />
          Gửi
        </Button>
      </div>
    </div>
  </div>
</template>
