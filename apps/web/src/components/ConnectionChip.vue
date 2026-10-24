<script setup lang="ts">
import { computed } from "vue";
import { sessions } from "../stores/sessions.ts";

const repairing = computed(() => sessions.stream?.needsResync ?? false);

const label = computed(() => {
  if (repairing.value) return "đang sửa journal";
  switch (sessions.connection) {
    case "live":
      return "đã kết nối";
    case "connecting":
      return "đang kết nối";
    case "closed":
      return "đang kết nối lại";
  }
});

const dot = computed(() => {
  if (repairing.value) return "bg-destructive animate-pulse";
  return sessions.connection === "live" ? "bg-primary animate-pulse" : "bg-muted-foreground";
});
</script>

<template>
  <div class="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
    <span class="size-[7px] rounded-full" :class="dot" />
    <span>{{ label }}</span>
  </div>
</template>
