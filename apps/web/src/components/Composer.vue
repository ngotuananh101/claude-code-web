<script setup lang="ts">
import { Input } from "@/components/ui/input";

// A disabled stub on purpose: no dispatch API exists yet (§9 comes next).
// Saying so beats a textarea that pretends to work.
</script>

<template>
  <footer class="composer">
    <Input
      disabled
      class="composer-box"
      placeholder="Sending prompts arrives with the dispatch API — not wired yet."
      aria-label="Prompt composer (not wired yet)"
    />
  </footer>
</template>

<style scoped>
.composer {
  padding: 14px 28px 18px;
  border-top: 1px solid var(--border);
}

/* The honest notice stays fully readable: the input's own disabled:opacity-50
   would dim it past legibility, and this unlayered rule outranks it. */
.composer-box {
  opacity: 1;
  color: var(--muted-foreground);
  font-size: 13px;
}
</style>
