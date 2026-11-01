<script setup lang="ts">
import { PanelLeftOpen } from "@lucide/vue";
import { useMediaQuery } from "@vueuse/core";
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import SessionRail from "../components/SessionRail.vue";
import {
  initialRailOpen,
  loadRailPreference,
  saveRailPreference,
} from "../features/layout/layout-prefs.ts";
import { loadSessions } from "../stores/sessions.ts";

const route = useRoute();

// Tailwind's lg breakpoint: below it the rail is a drawer over the page,
// above it the rail is a column beside the page.
const isWide = useMediaQuery("(min-width: 1024px)");

const openButton = ref<HTMLButtonElement | null>(null);
const railOpen = ref(initialRailOpen(loadRailPreference(), isWide.value));

// Crossing the breakpoint adopts that viewport's convention: a phone never
// inherits an inline rail, and a wide screen restores the stored choice.
watch(isWide, (wide) => {
  railOpen.value = initialRailOpen(loadRailPreference(), wide);
});

// Only the wide layout owns a stored choice; a drawer is a per-visit action.
// Collapsing removes the focused button from the DOM, so focus follows the
// edge tab that replaces it.
function toggleRail(): void {
  railOpen.value = !railOpen.value;
  if (isWide.value) saveRailPreference(railOpen.value);
  if (!railOpen.value) void nextTick(() => openButton.value?.focus());
}

function openRail(): void {
  railOpen.value = true;
}

function closeRail(): void {
  railOpen.value = false;
}

// A drawer left open would hide the page the operator just navigated to.
watch(
  () => route.fullPath,
  () => {
    if (!isWide.value) railOpen.value = false;
  },
);

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && !isWide.value) railOpen.value = false;
}

// The rail's session list stays fresh on every console page, not just the
// journal's — the dashboard and the runners console read the same store.
let refresh: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  refresh = setInterval(() => void loadSessions(), 15_000);
  window.addEventListener("keydown", onKeydown);
});
onUnmounted(() => {
  clearInterval(refresh);
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
      :class="!isWide && 'fixed inset-y-0 left-0 z-40 shadow-xl'"
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
        class="absolute top-1/2 left-0 z-30 -translate-y-1/2 cursor-pointer rounded-r-md border border-l-0 border-border bg-card py-2 pr-1 pl-0.5 text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Mở sidebar"
        title="Mở sidebar"
        @click="openRail"
      >
        <PanelLeftOpen :size="14" />
      </button>
      <RouterView />
    </main>
  </div>
</template>
