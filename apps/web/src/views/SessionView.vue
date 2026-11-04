<script setup lang="ts">
import type { AttachmentInfo, SessionMessage } from "@cc-web/protocol";
import { Loader2, PanelRightOpen } from "@lucide/vue";
import { useMediaQuery } from "@vueuse/core";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useI18n } from "@/lib/i18n";
import Composer from "../components/Composer.vue";
import EventJournal from "../components/EventJournal.vue";
import InspectPanel from "../components/InspectPanel.vue";
import { liveActivityTasks, taskStateFromEvents } from "../features/journal/background-tasks.ts";
import {
  initialInspectOpen,
  loadInspectPreference,
  saveInspectPreference,
} from "../features/layout/layout-prefs.ts";
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
const { t } = useI18n();

// Tailwind's lg breakpoint: the inspection panel sits beside the journal on
// wide screens and stacks under it on narrow ones. Both are the same splitter,
// so the drag handle sizes it either way.
const isWide = useMediaQuery("(min-width: 1024px)");
const panelDirection = computed<"horizontal" | "vertical">(() =>
  isWide.value ? "horizontal" : "vertical",
);

// Pixel widths keep the panel's default the same at every viewport width; the
// chat column takes whatever remains. The narrow default is the old h-72
// stack height, now resizable.
const inspectSize = computed(() =>
  isWide.value
    ? { defaultSize: 420, minSize: 280, maxSize: 900 }
    : { defaultSize: 288, minSize: 200, maxSize: 560 },
);

// The inspection panel can be hidden outright so the journal owns the full
// width. The choice outlives a reload, like the rail's, and applies at every
// viewport width because the panel docks in the splitter, not over it.
const inspectOpen = ref(initialInspectOpen(loadInspectPreference()));
const inspectOpenButton = ref<HTMLButtonElement | null>(null);

watch(inspectOpen, (open) => saveInspectPreference(open));

// Hiding unmounts the panel that held focus; focus follows the edge tab that
// replaces it, so a keyboard operator is not dropped on the body.
function closeInspect(): void {
  inspectOpen.value = false;
  void nextTick(() => inspectOpenButton.value?.focus());
}

function openInspect(): void {
  inspectOpen.value = true;
}

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

const activeLive = computed(() =>
  resolveSessionLive(active.value?.live, sessions.stream?.live ?? null),
);

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
    // If there is active agent activity in a subsequent turn after a completed turn
    // (e.g. from background task notification or scheduled task), keep the run active.
    if (
      event.type === "message.started" ||
      event.type === "message.delta" ||
      event.type === "tool.started" ||
      event.type === "approval.requested"
    ) {
      return event.runId;
    }
  }
  return null;
});

/**
 * Background work that outlived its run. Derived from the journal exactly like
 * the turns, so a replay rebuilds the same band. The level signal is what
 * decides: a missed `task.completed` cannot leave this list stuck.
 *
 * Deliberately independent of `liveRunId`: the Stop button stays tied to the
 * run, and this band is the honest indicator that something is still working.
 */
const backgroundTaskState = computed(() => taskStateFromEvents(sessions.stream?.events ?? []));
const backgroundTasks = computed(() => liveActivityTasks(backgroundTaskState.value));

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
    // Capture the session and its ids for the continuation: the fetch must
    // read the session this effect saw, and property narrowing does not
    // survive into an async closure.
    const targetSession = active.value;
    if (!targetSession?.runnerId || !targetSession.workspaceId) return;
    const workspaceId = targetSession.workspaceId;
    const runnerId = targetSession.runnerId;

    fetchedResume.value = targetResume;
    void (async () => {
      const result = await fetchSessionMessages(workspaceId, targetResume, runnerId);
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
// about the system — a time-of-day greeting, like the login page.
const greeting = computed(() => {
  const hour = new Date().getHours();
  if (hour < 5) return t("sessionView.greetingNight");
  if (hour < 12) return t("sessionView.greetingMorning");
  if (hour < 18) return t("sessionView.greetingAfternoon");
  return t("sessionView.greetingEvening");
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
  toast.success(t("sessionView.refreshed"));
}
</script>

<template>
  <section class="relative flex min-h-0 min-w-0 flex-1 flex-col">
    <template v-if="active">
      <ResizablePanelGroup
        :key="panelDirection"
        :direction="panelDirection"
        class="min-h-0 flex-1"
      >
        <ResizablePanel :min-size="35" class="min-w-0">
          <div class="flex h-full min-h-0 min-w-0 flex-col">
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
                  {{ t("sessionView.running") }}
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
              :background-tasks="backgroundTasks"
              :background-task-state="backgroundTaskState"
              :historical-messages="historicalMessages"
              :pending-run="activePendingRun"
            />
            <div v-else class="z-10 flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 class="size-4 animate-spin text-muted-foreground" />
              <span>{{ t("sessionView.loadingJournal") }}</span>
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
        </ResizablePanel>

        <ResizableHandle v-if="inspectOpen" with-handle />

        <!-- §16.1's secondary panel: read-only inspection beside the journal on
             wide screens, stacked under it on narrow ones. Drag the handle to
             resize it. It reads the pin from the rail's list, so it costs no
             extra request of its own until a tab is opened. Hiding it leaves
             the journal the full width and moves the way back to the edge tab
             below. -->
        <ResizablePanel
          v-if="inspectOpen"
          :default-size="inspectSize.defaultSize"
          :min-size="inspectSize.minSize"
          :max-size="inspectSize.maxSize"
          size-unit="px"
          class="min-w-0"
        >
          <InspectPanel
            :session-id="active.sessionId"
            class="h-full w-full"
            @close="closeInspect"
          />
        </ResizablePanel>
      </ResizablePanelGroup>

      <!-- Once hidden, the only way back is this edge tab, mirroring the
           rail's left edge tab. -->
      <button
        v-if="!inspectOpen"
        ref="inspectOpenButton"
        type="button"
        class="absolute top-1/2 right-0 z-30 min-h-11 min-w-9 -translate-y-1/2 touch-manipulation cursor-pointer rounded-l-md border border-r-0 border-border bg-card p-2 text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground active:bg-muted"
        :aria-label="t('sessionView.openInspector')"
        :title="t('sessionView.openInspector')"
        @click="openInspect"
      >
        <PanelRightOpen :size="14" />
      </button>
    </template>

    <template v-else>
      <div class="z-10 flex flex-1 flex-col items-center justify-center gap-5 px-6">
        <div class="grid justify-items-center gap-1.5 text-center">
          <h1 class="text-[26px] font-medium tracking-tight">{{ greeting }}</h1>
          <p class="text-sm text-muted-foreground">
            {{ t("sessionView.emptyHint") }}
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
            {{ t("sessionView.refresh") }}
          </Button>
        </div>
      </div>
    </template>
  </section>
</template>
