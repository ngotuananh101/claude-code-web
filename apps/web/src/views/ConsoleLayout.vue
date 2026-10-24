<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import SessionRail from "../components/SessionRail.vue";
import { loadSessions } from "../stores/sessions.ts";

// The rail's session list stays fresh on every console page, not just the
// journal's — the dashboard and the runners console read the same store.
let refresh: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  refresh = setInterval(() => void loadSessions(), 15_000);
});
onUnmounted(() => clearInterval(refresh));
</script>

<template>
  <div class="flex h-dvh overflow-hidden bg-background text-foreground">
    <SessionRail />
    <main class="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <RouterView />
    </main>
  </div>
</template>
