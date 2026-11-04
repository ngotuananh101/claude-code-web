<script setup lang="ts">
import { PanelLeftOpen } from "@lucide/vue";
import { useMediaQuery } from "@vueuse/core";
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import SessionRail from "../components/SessionRail.vue";
import {
  initialRailOpen,
  loadRailPreference,
  railOpenOnViewportChange,
  saveRailPreference,
} from "../features/layout/layout-prefs.ts";
import {
  createNotificationDedupe,
  formatBrowserNotification,
  getBrowserNotificationEnabled,
  shouldShowSystemNotification,
} from "../features/notifications/notification-events.ts";
import { useI18n } from "../lib/i18n/index.ts";
import { router } from "../router/index.ts";
import { socket } from "../services/socket.ts";
import { loadSessions, sessions } from "../stores/sessions.ts";

const { t } = useI18n();

const route = useRoute();

// Tailwind's lg breakpoint: below it the rail is a drawer over the page,
// above it the rail is a column beside the page.
const isWide = useMediaQuery("(min-width: 1024px)");

const openButton = ref<HTMLButtonElement | null>(null);
const railOpen = ref(initialRailOpen(loadRailPreference(), isWide.value));

// Crossing the breakpoint adopts that viewport's convention: narrowing turns
// the rail into a drawer and starts it collapsed; widening restores the
// stored choice for the inline rail.
watch(isWide, (wide) => {
  railOpen.value = railOpenOnViewportChange(loadRailPreference(), wide);
});

// Every action on the rail itself is the operator's choice, so it is stored
// at every viewport width; a route change is navigation, not a choice, and
// closes the drawer without overwriting the preference.
// Collapsing removes the focused button from the DOM, so focus follows the
// edge tab that replaces it.
function toggleRail(): void {
  railOpen.value = !railOpen.value;
  saveRailPreference(railOpen.value);
  if (!railOpen.value) void nextTick(() => openButton.value?.focus());
}

function openRail(): void {
  railOpen.value = true;
  saveRailPreference(true);
}

function closeRail(): void {
  railOpen.value = false;
  saveRailPreference(false);
}

// A drawer left open would hide the page the operator just navigated to.
watch(
  () => route.fullPath,
  () => {
    if (!isWide.value) railOpen.value = false;
  },
);

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && !isWide.value) closeRail();
}

// The rail's session list stays fresh on every console page, not just the
// journal's — the dashboard and the runners console read the same store.
let refresh: ReturnType<typeof setInterval> | undefined;
let unsubscribeNotifications: (() => void) | undefined;
const notificationDedupe = createNotificationDedupe();

onMounted(() => {
  refresh = setInterval(() => void loadSessions(), 15_000);
  window.addEventListener("keydown", onKeydown);
  // N1 browser notifications: the server sends one bounded `notification`
  // frame per notifiable event to every socket of the owner, so this fires
  // even when the operator is on another session or the tab is hidden.
  // The journal itself covers the case where the session is open and
  // visible, so no system notification is shown there.
  unsubscribeNotifications = socket.onFrame((frame) => {
    if (frame["type"] !== "notification") return;
    const eventId = typeof frame["eventId"] === "string" ? frame["eventId"] : "";
    const sessionId = typeof frame["sessionId"] === "string" ? frame["sessionId"] : "";
    if (eventId === "" || sessionId === "") return;
    if (notificationDedupe.seen(eventId)) return;
    const sessionTitle =
      typeof frame["sessionTitle"] === "string" ? frame["sessionTitle"] : undefined;
    const toolName = typeof frame["toolName"] === "string" ? frame["toolName"] : undefined;
    const inputSummary =
      typeof frame["inputSummary"] === "string" ? frame["inputSummary"] : undefined;
    const content = formatBrowserNotification({
      eventId,
      type: typeof frame["notificationType"] === "string" ? frame["notificationType"] : "",
      sessionId,
      ...(sessionTitle === undefined ? {} : { sessionTitle }),
      ...(toolName === undefined ? {} : { toolName }),
      ...(inputSummary === undefined ? {} : { inputSummary }),
    });
    if (content === null) return;
    const permission =
      typeof Notification === "undefined" ? "unsupported" : Notification.permission;
    const browserEnabled = getBrowserNotificationEnabled({
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
    });
    if (
      !shouldShowSystemNotification({
        permission,
        browserEnabled,
        documentHidden: document.hidden,
        currentSessionId: sessions.activeId,
        eventSessionId: sessionId,
      })
    ) {
      return;
    }
    const notification = new Notification(content.title, { body: content.body });
    notification.onclick = () => {
      window.focus();
      void router.push(`/sessions/${sessionId}`);
      notification.close();
    };
  });
});
onUnmounted(() => {
  clearInterval(refresh);
  unsubscribeNotifications?.();
  window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div class="flex h-dvh overflow-hidden bg-background text-foreground">
    <!-- The drawer never covers the page without a way back: the backdrop,
         Escape, a route change, or the rail's own button closes it. -->
    <div
      v-if="railOpen && !isWide"
      class="fixed inset-0 z-30 bg-black/50"
      aria-hidden="true"
      @click="closeRail"
    />

    <SessionRail
      v-if="railOpen"
      :class="!isWide && 'fixed inset-y-0 left-0 z-40 h-dvh max-w-[85vw] shadow-xl'"
      @close="toggleRail"
    />

    <main class="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <!-- Once collapsed, the only way back is this edge tab. It sits on the
           page's left edge rather than in a header so every console view gets
           it without knowing the rail exists. -->
      <button
        v-if="!railOpen"
        ref="openButton"
        type="button"
        class="absolute top-1/2 left-0 z-30 min-h-11 min-w-9 -translate-y-1/2 touch-manipulation cursor-pointer rounded-r-md border border-l-0 border-border bg-card p-2 text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground active:bg-muted"
        :aria-label="t('rail.openSidebar')"
        :title="t('rail.openSidebar')"
        @click="openRail"
      >
        <PanelLeftOpen :size="14" />
      </button>
      <RouterView />
    </main>
  </div>
</template>
