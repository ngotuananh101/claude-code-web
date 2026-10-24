<script setup lang="ts">
import { computed } from "vue";
import { sessions } from "../stores/sessions.ts";

const repairing = computed(() => sessions.stream?.needsResync ?? false);

const label = computed(() => {
  if (repairing.value) return "repairing transcript";
  switch (sessions.connection) {
    case "live":
      return "connected";
    case "connecting":
      return "connecting";
    case "closed":
      return "reconnecting";
  }
});

const tone = computed(() => {
  if (repairing.value) return "amber";
  return sessions.connection === "live" ? "pine" : "mute";
});
</script>

<template>
  <div class="chip" :class="tone">
    <i class="dot" />
    <span class="mono">{{ label }}</span>
  </div>
</template>

<style scoped>
.chip {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 14px 20px 16px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  color: var(--mute);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.pine .dot {
  background: var(--pine);
  animation: livepulse 2.4s ease-in-out infinite;
}

.amber .dot {
  background: var(--amber);
  animation: livepulse 1.2s ease-in-out infinite;
}

.mute .dot {
  background: var(--mute);
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
</style>
