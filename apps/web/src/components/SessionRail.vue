<script setup lang="ts">
import { openSession, sessions } from "../stores/sessions.ts";
import ConnectionChip from "./ConnectionChip.vue";
</script>

<template>
  <aside class="rail">
    <p class="wordmark">cc-web</p>
    <h2 class="rail-title">Sessions</h2>

    <ul v-if="sessions.sessions.length > 0" class="session-list">
      <li v-for="s in sessions.sessions" :key="s.sessionId">
        <button
          class="session-row"
          :class="{ active: s.sessionId === sessions.activeId }"
          @click="openSession(s.sessionId)"
        >
          <span class="session-id">{{ s.sessionId }}</span>
          <span class="session-meta">
            <span class="mono">{{ s.watermark }}</span>
            <i v-if="s.live" class="live-dot" title="A run is in flight" />
          </span>
        </button>
      </li>
    </ul>
    <p v-else-if="sessions.loaded" class="rail-empty">
      No sessions yet. Enroll a runner and dispatch a run — they land here as
      they start.
    </p>
    <p v-else class="rail-empty">Reading the journal…</p>

    <ConnectionChip class="rail-foot" />
  </aside>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #f4f5f1;
}

.wordmark {
  font-family: var(--machine);
  font-size: 13px;
  color: var(--pine);
  margin: 0;
  padding: 18px 20px 0;
}

.rail-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--mute);
  margin: 22px 0 8px;
  padding: 0 20px;
}

.session-list {
  list-style: none;
  margin: 0;
  padding: 0 12px;
  overflow-y: auto;
  flex: 1;
}

.session-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  text-align: left;
  font: inherit;
  background: none;
  border: none;
  border-radius: 6px;
  padding: 9px 10px;
  cursor: pointer;
  color: var(--ink);
}

.session-row:hover {
  background: var(--pine-wash);
}

.session-row.active {
  background: var(--pine-wash);
  box-shadow: inset 2px 0 0 var(--pine);
}

.session-id {
  font-family: var(--machine);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-meta {
  display: inline-flex;
  align-items: baseline;
  gap: 7px;
  color: var(--mute);
  font-size: 12px;
  flex-shrink: 0;
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

.rail-empty {
  color: var(--mute);
  font-size: 13px;
  margin: 4px 20px;
}

.rail-foot {
  margin-top: auto;
}
</style>
