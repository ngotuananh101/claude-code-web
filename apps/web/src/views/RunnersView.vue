<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";

/**
 * The runners console (§6.1): the owner's connectors and the one-time token
 * a new one is set up with. The token exists in this component's state and in
 * the mint response alone — the server kept only its hash, and nothing here
 * writes it anywhere a reload could recover.
 */

type RunnerRow = {
  runnerId: string;
  createdAt: number;
  revokedAt: number | null;
};

const runners = ref<RunnerRow[]>([]);
const minted = ref<{ runnerId: string; token: string } | null>(null);
const mintBusy = ref(false);
const origin = location.origin;

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
  // Pinned vi-VN for the same reason as the rail's timestamps: deterministic
  // alongside the Vietnamese labels around it.
  return new Date(ms).toLocaleString("vi-VN", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function load(): Promise<void> {
  const response = await fetch("/api/runners");
  if (!response.ok) {
    toast.error(await response.text());
    return;
  }
  runners.value = ((await response.json()) as { runners: RunnerRow[] }).runners;
}

async function mint(): Promise<void> {
  mintBusy.value = true;
  try {
    const response = await fetch("/api/runners", { method: "POST" });
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
    toast.success("Token đã copy");
  } catch {
    // An unfocused window or a clipboard the page may not write. The value
    // stays select-all, so the owner can still copy it by hand.
    toast.error("Không copy được token — chọn và copy thủ công.");
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="runners overflow-y-auto">
    <div class="page">
      <p class="wordmark font-mono">cc-web / runners</p>
      <h1>Connectors.</h1>
      <p class="lede">
        Runner là connector chạy trên máy chứa dự án của bạn: nó tự kết nối ra
        server này, nhận lệnh, và ghi lại những gì agent đã làm vào journal.
      </p>

      <div class="toolbar">
        <Button class="mint" :disabled="mintBusy" @click="mint">Thêm runner</Button>
      </div>

      <section v-if="minted" class="event minted">
        <span class="seq font-mono" aria-hidden="true">{{ mintedSeq }}</span>
        <div class="event-body">
          <p class="minted-title">Token runner dùng một lần</p>
          <p class="minted-note">
            Chỉ hiển thị một lần — server chỉ lưu hash của nó. Copy ngay bây giờ.
          </p>
          <div class="secret font-mono">
            <span class="secret-value">{{ minted.token }}</span>
            <button class="copy" type="button" @click="copyToken">copy</button>
          </div>
          <div class="field">
            <span class="field-label font-mono">runner id</span>
            <span class="secret-value font-mono">{{ minted.runnerId }}</span>
          </div>
          <pre class="setup font-mono">{{ setupCommands }}</pre>
          <Button variant="outline" size="sm" class="done" @click="minted = null">
            Xong
          </Button>
        </div>
      </section>

      <p v-if="runners.length === 0 && minted === null" class="empty">
        Chưa có runner nào. Mint một token rồi chạy lệnh setup trên máy đó.
      </p>

      <div v-for="(runner, i) in runners" :key="runner.runnerId" class="event-row">
        <span class="seq font-mono" :title="new Date(runner.createdAt).toISOString()">
          {{ pad(i + 1) }}
        </span>
        <div class="event-body">
          <span class="runner-id font-mono">{{ runner.runnerId }}</span>
          <span class="runner-meta font-mono">
            đã kết nối {{ fmt(runner.createdAt) }}
            <template v-if="runner.revokedAt !== null"> · đã thu hồi {{ fmt(runner.revokedAt) }}</template>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.runners {
  min-height: 100%;
  display: grid;
  place-items: start center;
  padding: 48px 0;
}

.page {
  width: min(720px, calc(100vw - 48px));
}

/* The journal's run divider: mono wordmark, hairline running out. */
.wordmark {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 13px;
  color: var(--primary);
  margin: 0 0 26px;
}

.wordmark::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--border);
}

h1 {
  font-size: 26px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.25;
  margin: 0 0 8px;
}

.lede {
  color: var(--muted-foreground);
  font-size: 14px;
  line-height: 1.5;
  margin: 0 0 26px;
}

.toolbar {
  display: flex;
  margin-bottom: 26px;
}

/* A minted token is the journal's newest event: sequence gutter, payload. */
.event {
  display: grid;
  grid-template-columns: 48px 1fr;
  column-gap: 14px;
  padding: 16px 0;
  border-top: 1px solid var(--border);
}

.seq {
  text-align: right;
  line-height: 14px;
  color: var(--muted-foreground);
  font-size: 12px;
  user-select: all;
}

.event-body {
  display: grid;
  gap: 14px;
}

.minted-title {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
}

.minted-note {
  margin: -8px 0 0;
  color: var(--muted-foreground);
  font-size: 13px;
}

.field {
  display: grid;
  gap: 4px;
}

.field-label {
  color: var(--muted-foreground);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

/* The secret itself: mono, click-to-select-all, copy beside it. */
.secret {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  background: var(--muted);
}

.secret-value {
  font-size: 13px;
  user-select: all;
  word-break: break-all;
}

.copy {
  margin-left: auto;
  padding: 2px 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted-foreground);
  font-size: 11px;
  cursor: pointer;
}

.copy:hover {
  color: var(--foreground);
}

.setup {
  margin: 0;
  padding: 10px 12px;
  border-left: 2px solid var(--border);
  color: var(--muted-foreground);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

.done {
  justify-self: start;
}

.empty {
  margin: 30px 0;
  padding: 16px 0 0;
  border-top: 1px solid var(--border);
  color: var(--muted-foreground);
  font-size: 14px;
}

.event-row {
  display: grid;
  grid-template-columns: 48px 1fr;
  column-gap: 14px;
  padding: 12px 0;
  border-top: 1px solid var(--border);
}

.event-row:hover {
  background: var(--muted);
}

.runner-id {
  font-size: 13px;
  word-break: break-all;
}

.runner-meta {
  color: var(--muted-foreground);
  font-size: 12px;
}

@media (max-width: 379px) {
  .event,
  .event-row {
    grid-template-columns: 1fr;
    row-gap: 8px;
  }

  .seq {
    text-align: left;
  }
}
</style>
