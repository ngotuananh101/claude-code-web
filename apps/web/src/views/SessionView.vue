<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import Composer from "../components/Composer.vue";
import ConnectionChip from "../components/ConnectionChip.vue";
import EventJournal from "../components/EventJournal.vue";
import SessionRail from "../components/SessionRail.vue";
import { loadSessions, openSession, resolveSessionLive, sessions } from "../stores/sessions.ts";

const active = computed(() => sessions.sessions.find((s) => s.sessionId === sessions.activeId));

const activeLive = computed(() => resolveSessionLive(active.value?.live, sessions.stream?.live));

let refresh: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  // Reopen the held session after a reload; otherwise take the most recent.
  if (sessions.activeId === null && sessions.sessions.length > 0) {
    openSession(sessions.sessions[0]!.sessionId);
  }
  refresh = setInterval(() => void loadSessions(), 15_000);
});
onUnmounted(() => clearInterval(refresh));
</script>

<template>
  <div class="frame">
    <SessionRail />
    <section class="stage">
      <header v-if="active" class="stage-head">
        <span class="session-id">{{ active.sessionId }}</span>
        <span class="head-meta">
          <span class="mono">{{ active.watermark }}</span>
          <span v-if="activeLive" class="live-flag"><i class="live-dot" /> live</span>
        </span>
      </header>
      <header v-else class="stage-head">
        <span class="head-meta head-idle">No session selected.</span>
      </header>

      <EventJournal
        v-if="sessions.stream !== null"
        :events="sessions.stream.events"
        :needs-resync="sessions.stream.needsResync"
        :session-live="activeLive"
      />
      <div v-else class="stage-empty">
        <p>Select a session from the rail, or wait for one to start.</p>
      </div>

      <Composer />
    </section>
  </div>
  <ConnectionChip />
</template>

<style scoped>
.frame {
  display: grid;
  grid-template-columns: 264px 1fr;
  height: 100vh;
}

.stage {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-left: 1px solid var(--line);
}

.stage-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 28px 14px;
  border-bottom: 1px solid var(--line);
}

.session-id {
  font-family: var(--machine);
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.head-meta {
  display: flex;
  align-items: baseline;
  gap: 12px;
  color: var(--mute);
  font-size: 12px;
  flex-shrink: 0;
}

.head-idle {
  font-family: var(--voice);
}

.live-flag {
  color: var(--pine);
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}

.live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--pine);
  display: inline-block;
  align-self: center;
  animation: livepulse 2.4s ease-in-out infinite;
}

@keyframes livepulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

.stage-empty {
  flex: 1;
  display: grid;
  place-items: center;
  color: var(--mute);
}
</style>
