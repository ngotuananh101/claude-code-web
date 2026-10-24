<script setup lang="ts">
import { Input } from "@/components/ui/input";

// A disabled stub on purpose: no dispatch API exists yet (§11 comes next).
// Saying so beats a textarea that pretends to work. The card is the shell the
// real composer lands in — project/branch chips, permission and model
// pickers, the send button — so §11 only has to fill it.
</script>

<template>
  <div class="rounded-xl border border-border bg-card shadow-sm">
    <Input
      disabled
      class="h-10 rounded-xl border-0 bg-transparent px-4 text-[13px] text-muted-foreground shadow-none opacity-100 focus-visible:border-transparent focus-visible:ring-0 disabled:opacity-100"
      placeholder="Prompt dispatch arrives with the run API — this box lights up then."
      aria-label="Prompt composer (not wired yet)"
    />
  </div>
</template>
