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
      <span class="font-mono">{{ label }}</span>
    </Badge>
  </div>
</template>

<style scoped>
.chip {
  margin: 14px 20px 16px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.chip-status {
  gap: 8px;
  font-size: 12px;
  border-color: var(--border);
  color: var(--muted-foreground);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.pine {
  color: var(--primary);
}

.pine .dot {
  background: var(--primary);
  animation: livepulse 2.4s ease-in-out infinite;
}

.amber {
  color: var(--destructive);
}

.amber .dot {
  background: var(--destructive);
  animation: livepulse 1.2s ease-in-out infinite;
}

.mute {
  color: var(--muted-foreground);
}

.mute .dot {
  background: var(--muted-foreground);
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
