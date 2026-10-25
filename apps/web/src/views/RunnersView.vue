<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

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
  <ScrollArea class="min-h-0 flex-1">
    <div class="mx-auto w-full max-w-[720px] px-7 py-7">
      <p class="mb-6 flex items-center gap-3.5 font-mono text-[13px] text-primary">
        cc-web / runners
        <span class="h-px flex-1 bg-border" aria-hidden="true" />
      </p>
      <h1 class="mb-2 text-[26px] font-medium tracking-tight">Connectors.</h1>
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
            Chỉ hiển thị một lần — server chỉ lưu hash của nó. Copy ngay bây giờ.
          </p>
          <div class="flex items-center gap-3 rounded-md border border-border bg-muted px-3 py-2.5">
            <span class="min-w-0 flex-1 break-all font-mono text-[13px] select-all">{{ minted.token }}</span>
            <Button
              variant="outline"
              size="xs"
              class="shrink-0"
              @click="copyToken"
            >
              copy
            </Button>
          </div>
          <div class="grid gap-1">
            <span class="font-mono text-xs tracking-wider text-muted-foreground uppercase">runner id</span>
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
        <div class="grid min-w-0 gap-0.5">
          <span class="break-all font-mono text-[13px]">{{ runner.runnerId }}</span>
          <span class="font-mono text-xs text-muted-foreground">
            đã kết nối {{ fmt(runner.createdAt) }}
            <template v-if="runner.revokedAt !== null"> · đã thu hồi {{ fmt(runner.revokedAt) }}</template>
          </span>
        </div>
      </div>
    </div>
  </ScrollArea>
</template>
