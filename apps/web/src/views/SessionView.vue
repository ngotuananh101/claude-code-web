<script setup lang="ts">
import type { AttachmentInfo, SessionMessage } from "@cc-web/protocol";
import { Loader2 } from "@lucide/vue";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import Composer from "../components/Composer.vue";
import EventJournal from "../components/EventJournal.vue";
import InspectPanel from "../components/InspectPanel.vue";
import { fetchSessionMessages } from "../services/sessions-api.ts";
import {
  closeSession,
  loadSessions,
  openSession,
  resolveSessionLive,
  type SessionSummary,
  sessions,
} from "../stores/sessions.ts";

/**
 * The session workspace. The URL is the source of truth for which session is
 * held — `/sessions` is the new-session page (greeting, composer, chips),
 * `/sessions/<id>` opens that journal — so the browser's back button moves
 * between journals the way an operator expects.
 */

const route = useRoute();
const router = useRouter();

const routeSession = computed(() => {
  const id = route.params.sessionId;
  return typeof id === "string" && id !== "" ? id : null;
});

const active = computed<SessionSummary | undefined>(() => {
  const currentId = routeSession.value ?? sessions.activeId;
  if (!currentId) return undefined;
  const found = sessions.sessions.find((s) => s.sessionId === currentId);
  if (found) return found;
  // Synthesize session summary so the journal mounts immediately for new sessions
  return {
    sessionId: currentId,
    watermark: sessions.stream?.through ?? 0,
    eventCount: sessions.stream?.events.length ?? 0,
    lastEventType: null,
    lastIngestedAt: Date.now(),
    live: true,
    runnerId: null,
    workspaceId: null,
    sdkSessionId: null,
  };
});

const activeLive = computed(() => resolveSessionLive(active.value?.live, sessions.stream?.live));

/** Preloaded historical messages when resuming an existing session (§16.1, Task 13). */
const historicalMessages = ref<SessionMessage[]>([]);

/** The run this page started, until its terminal event clears it. */
const startedRun = ref<{ sessionId: string; runId: string } | null>(null);

/** Optimistic pending run state while events stream from the runner. */
const pendingRun = ref<{
  sessionId: string;
  runId: string;
  prompt: string;
  attachments?: AttachmentInfo[];
} | null>(null);

/**
 * The run a stop request would target. Prefer the one started here (it may not
 * be in the journal yet); otherwise walk the journal backwards — the newest
 * `run.started` is the in-flight run, unless a terminal event for it came
 * after, in which case nothing is running.
 */
const liveRunId = computed(() => {
  const currentSessionId = active.value?.sessionId;
  if (!currentSessionId) return null;
  if (startedRun.value !== null && startedRun.value.sessionId === currentSessionId) {
    return startedRun.value.runId;
  }
  const events = sessions.stream?.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "run.started") return event.runId;
    if (
      event.type === "run.finished" ||
      event.type === "run.failed" ||
      event.type === "run.interrupted"
    ) {
      return null;
    }
  }
  return null;
});

// A terminal event for the run this page started is the honest "it is over":
// the composer's stop button disappears with it, not on a timer.
watch(
  () => sessions.stream?.events.length,
  () => {
    const run = startedRun.value;
    if (run === null) return;
    const currentSessionId = active.value?.sessionId;
    if (run.sessionId !== currentSessionId) return;
    const terminal = (sessions.stream?.events ?? []).some(
      (event) =>
        event.runId === run.runId &&
        (event.type === "run.finished" ||
          event.type === "run.failed" ||
          event.type === "run.interrupted"),
    );
    if (terminal) {
      startedRun.value = null;
      if (pendingRun.value?.runId === run.runId) {
        pendingRun.value = null;
      }
    }
  },
);

// When a resumed session's first `run.started` event carries a `resumeSessionId`,
// fetch the historical messages from the runner so they render above the live
// journal (§16.1, Task 13). Gated on the pin being available so the runner can
// resolve the workspace path.
const fetchedResume = ref<string | null>(null);
watch(
  () => sessions.stream?.events,
  () => {
    const stream = sessions.stream;
    if (stream === null) return;
    // Find the first run.started event's resumeSessionId.
    const started = stream.events.find((e) => e.type === "run.started");
    const resumeSessionId =
      started !== undefined
        ? ((started.payload ?? {}) as Record<string, unknown>)["resumeSessionId"]
        : undefined;
    const payloadResume =
      typeof resumeSessionId === "string" && resumeSessionId.trim() !== ""
        ? resumeSessionId.trim()
        : undefined;

    // Prefer the session's own pin; fall back to the first run.started's
    // resumeSessionId. Avoid re-fetching the same session.
    const targetResume = active.value?.sdkSessionId ?? payloadResume;
    if (targetResume === undefined || targetResume === "") return;
    if (fetchedResume.value === targetResume) return;
    if (!active.value?.runnerId || !active.value?.workspaceId) return;

    fetchedResume.value = targetResume;
    void (async () => {
      const result = await fetchSessionMessages(
        active.value.workspaceId,
        targetResume,
        active.value.runnerId,
      );
      if (result.ok) {
        historicalMessages.value = result.messages;
      } else {
        toast.error(result.message);
      }
    })();
  },
);

const activePendingRun = computed(() => {
  const currentSessionId = active.value?.sessionId;
  if (!currentSessionId) return undefined;
  if (pendingRun.value !== null && pendingRun.value.sessionId === currentSessionId) {
    return pendingRun.value;
  }
  return undefined;
});

/** A run started from the composer opens the journal it will stream into. */
function onStarted(
  sessionId: string,
  runId: string,
  promptText?: string,
  attachments?: AttachmentInfo[],
): void {
  startedRun.value = { sessionId, runId };
  if (promptText) {
    pendingRun.value = {
      sessionId,
      runId,
      prompt: promptText,
      ...(attachments ? { attachments } : {}),
    };
  }
  void loadSessions();
  if (sessionId !== routeSession.value) router.push(`/sessions/${sessionId}`);
}

// The greeting is the one line of the console that talks to the operator, not
// about the system — time-of-day Vietnamese, like the login page.
const greeting = computed(() => {
  const hour = new Date().getHours();
  if (hour < 5) return "Khuya rồi đấy — nhớ giữ sức khỏe.";
  if (hour < 12) return "Chào buổi sáng.";
  if (hour < 18) return "Chào buổi chiều.";
  return "Chào buổi tối.";
});

/** Follows the URL in one direction: route → held session. */
function followRoute(): void {
  const id = routeSession.value;
  historicalMessages.value = [];
  fetchedResume.value = null;
  if (id === null) {
    if (sessions.activeId !== null) closeSession();
    return;
  }
  if (id !== sessions.activeId) openSession(id);
}

onMounted(followRoute);
watch(routeSession, followRoute);

async function refreshNow(): Promise<void> {
  await loadSessions();
  toast.success("Đã làm mới danh sách phiên.");
}
</script>

<template>
  <section class="relative flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
    <template v-if="active">
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          class="z-10 mx-auto flex w-full max-w-4xl items-baseline justify-between gap-4 px-4 pt-4 pb-3 md:px-6"
        >
          <div class="flex min-w-0 items-center gap-2 truncate">
            <span
              class="truncate text-sm"
              :class="active.title ? 'font-medium font-sans text-foreground' : 'font-mono text-[13px] text-muted-foreground'"
              :title="active.title || active.sessionId"
            >
              {{ active.title || active.sessionId }}
            </span>
            <span
              v-if="active.title"
              class="truncate font-mono text-xs text-muted-foreground"
              :title="active.sessionId"
            >
              ({{ active.sessionId }})
            </span>
          </div>
          <span class="flex shrink-0 items-baseline gap-3 font-mono text-xs text-muted-foreground">
            <span>{{ active.watermark }}</span>
            <span v-if="activeLive" class="inline-flex items-center gap-1.5 text-primary">
              <i class="size-[7px] animate-pulse rounded-full bg-primary" />
              đang chạy
            </span>
          </span>
        </header>

        <EventJournal
          v-if="sessions.stream !== null"
          :key="active.sessionId"
          class="z-10"
          :events="sessions.stream.events"
          :needs-resync="sessions.stream.needsResync"
          :session-live="activeLive"
          :historical-messages="historicalMessages"
          :pending-run="activePendingRun"
        />
        <div v-else class="z-10 flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="size-4 animate-spin text-muted-foreground" />
          <span>Đang tải nhật ký phiên…</span>
        </div>

        <div class="z-10 px-4 pt-2 pb-4.5 md:px-6">
          <Composer
            class="mx-auto max-w-4xl"
            :session-id="routeSession"
            :active-run-id="liveRunId"
            @started="onStarted"
          />
        </div>
      </div>

      <!-- §16.1's secondary panel: read-only inspection beside the journal on
           wide screens, stacked under it on narrow ones. It reads the pin from
           the rail's list, so it costs no extra request of its own until a tab
           is opened. -->
      <InspectPanel
        :session-id="active.sessionId"
        class="z-10 h-72 shrink-0 border-t border-border/60 lg:h-auto lg:w-[420px] lg:border-t-0 lg:border-l"
      />
    </template>

    <template v-else>
      <div class="z-10 flex flex-1 flex-col items-center justify-center gap-5 px-6">
        <div class="grid justify-items-center gap-1.5 text-center">
          <h1 class="text-[26px] font-medium tracking-tight">{{ greeting }}</h1>
          <p class="text-sm text-muted-foreground">
            Chọn runner, bấm Duyệt… để mở thư mục, rồi chọn phiên trong đó hoặc tạo phiên mới.
          </p>
        </div>

        <Composer
          class="w-full max-w-4xl"
          :session-id="routeSession"
          :active-run-id="null"
          @started="onStarted"
        />

        <div class="flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="outline"
            size="xs"
            class="rounded-full bg-card px-3.5 hover:border-primary/40 hover:text-foreground"
            as-child
          >
            <RouterLink to="/runners">runners</RouterLink>
          </Button>
          <Button
            variant="outline"
            size="xs"
            class="rounded-full bg-card px-3.5 hover:border-primary/40 hover:text-foreground"
            @click="refreshNow"
          >
            làm mới
          </Button>
        </div>
      </div>
    </template>
  </section>
</template>
