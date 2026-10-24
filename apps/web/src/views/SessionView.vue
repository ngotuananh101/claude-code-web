<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { RouterLink } from "vue-router";
import { toast } from "vue-sonner";
import Composer from "../components/Composer.vue";
import EventJournal from "../components/EventJournal.vue";
import SessionRail from "../components/SessionRail.vue";
import { loadSessions, openSession, resolveSessionLive, sessions } from "../stores/sessions.ts";

const active = computed(() => sessions.sessions.find((s) => s.sessionId === sessions.activeId));

const activeLive = computed(() => resolveSessionLive(active.value?.live, sessions.stream?.live));

// The greeting is the one line of the console that talks to the operator, not
// about the system — time-of-day Vietnamese, like the login page.
const greeting = computed(() => {
  const hour = new Date().getHours();
  if (hour < 5) return "Khuya rồi đấy — nhớ giữ sức khỏe.";
  if (hour < 12) return "Chào buổi sáng.";
  if (hour < 18) return "Chào buổi chiều.";
  return "Chào buổi tối.";
});

let refresh: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  // Reopen the held session after a reload; otherwise take the most recent.
  if (sessions.activeId === null && sessions.sessions.length > 0) {
    openSession(sessions.sessions[0]!.sessionId);
  }
  refresh = setInterval(() => void loadSessions(), 15_000);
});
onUnmounted(() => clearInterval(refresh));

async function refreshNow(): Promise<void> {
  await loadSessions();
  toast.success("Đã làm mới danh sách phiên.");
}
</script>

<template>
  <div class="flex h-dvh overflow-hidden bg-background text-foreground">
    <SessionRail />
    <section class="relative flex min-w-0 flex-1 flex-col">
      <!-- The faint wordmark sitting behind everything, the way the reference
           console carries its own. -->
      <div aria-hidden="true" class="pointer-events-none absolute inset-0 grid place-items-center">
        <span class="font-mono text-[min(38vw,380px)] leading-none font-semibold text-foreground/3 select-none">
          cc
        </span>
      </div>

      <template v-if="active">
        <header class="z-10 flex items-baseline justify-between gap-4 border-b border-border px-7 pt-4 pb-3">
          <span class="truncate font-mono text-[13px]">{{ active.sessionId }}</span>
          <span class="flex shrink-0 items-baseline gap-3 font-mono text-xs text-muted-foreground">
            <span>{{ active.watermark }}</span>
            <span v-if="activeLive" class="inline-flex items-center gap-1.5 text-primary">
              <i class="size-[7px] animate-pulse rounded-full bg-primary" />
              live
            </span>
          </span>
        </header>

        <EventJournal
          v-if="sessions.stream !== null"
          class="z-10"
          :events="sessions.stream.events"
          :needs-resync="sessions.stream.needsResync"
          :session-live="activeLive"
        />
        <div v-else class="z-10 flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Waiting for the journal…
        </div>

        <div class="z-10 px-7 pt-2 pb-4.5">
          <Composer />
        </div>
      </template>

      <template v-else>
        <div class="z-10 flex flex-1 flex-col items-center justify-center gap-5 px-6">
          <div class="grid justify-items-center gap-1.5 text-center">
            <h1 class="text-[26px] font-medium tracking-tight">{{ greeting }}</h1>
            <p class="text-sm text-muted-foreground">
              Open a session from the rail, or wait for a runner to start one.
            </p>
          </div>

          <Composer class="w-full max-w-[660px]" />

          <div class="flex flex-wrap items-center justify-center gap-2">
            <RouterLink
              to="/runners"
              class="rounded-full border border-border bg-card px-3.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              runners
            </RouterLink>
            <button
              type="button"
              class="cursor-pointer rounded-full border border-border bg-card px-3.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              @click="refreshNow"
            >
              refresh
            </button>
            <button
              v-if="sessions.sessions.length > 0"
              type="button"
              class="cursor-pointer rounded-full border border-border bg-card px-3.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              @click="openSession(sessions.sessions[0]!.sessionId)"
            >
              open latest journal
            </button>
          </div>
        </div>
      </template>
    </section>
  </div>
</template>
