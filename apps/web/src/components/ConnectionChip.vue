<script setup lang="ts">
import { computed } from "vue";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/lib/i18n";
import { sessions } from "../stores/sessions.ts";

const { t } = useI18n();

const repairing = computed(() => sessions.stream?.needsResync ?? false);

const label = computed(() => {
  if (repairing.value) return t("connection.repairing");
  switch (sessions.connection) {
    case "live":
      return t("connection.connected");
    case "connecting":
      return t("connection.connecting");
    case "closed":
      return t("connection.reconnecting");
  }
});

const dot = computed(() => {
  if (repairing.value) return "bg-destructive animate-pulse";
  return sessions.connection === "live" ? "bg-primary animate-pulse" : "bg-muted-foreground";
});
</script>

<template>
  <Badge
    variant="outline"
    class="h-auto min-w-0 max-w-[9rem] gap-1.5 py-1 font-mono text-[11px] font-normal text-muted-foreground"
  >
    <span class="size-[7px] shrink-0 rounded-full" :class="dot" />
    <span class="truncate">{{ label }}</span>
  </Badge>
</template>
