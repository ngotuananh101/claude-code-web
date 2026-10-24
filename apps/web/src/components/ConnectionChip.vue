<script setup lang="ts">
import { computed } from "vue";
import { Badge } from "@/components/ui/badge";
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
  <div class="chip">
    <Badge variant="outline" class="chip-status" :class="tone">
      <i class="dot" />
      <span class="mono">{{ label }}</span>
    </Badge>
  </div>
</template>

<style scoped>
.chip {
  margin: 14px 20px 16px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.chip-status {
  gap: 8px;
  font-size: 12px;
  border-color: var(--line);
  color: var(--mute);
}

.chip-status .mono {
  font-size: 12px;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.pine {
  color: var(--pine);
}

.pine .dot {
  background: var(--pine);
  animation: livepulse 2.4s ease-in-out infinite;
}

.amber {
  color: var(--amber);
}

.amber .dot {
  background: var(--amber);
  animation: livepulse 1.2s ease-in-out infinite;
}

.mute {
  color: var(--mute);
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
