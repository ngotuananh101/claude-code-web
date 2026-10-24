<script setup lang="ts">
// A disabled stub on purpose: no dispatch API exists yet (§9 comes next).
// Saying so beats a textarea that pretends to work.
</script>

<template>
  <footer class="composer">
    <div class="composer-box" aria-disabled="true">
      <span>Sending prompts arrives with the dispatch API — not wired yet.</span>
    </div>
  </footer>
</template>

<style scoped>
.composer {
  padding: 14px 28px 18px;
  border-top: 1px solid var(--line);
}

.composer-box {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px 14px;
  color: var(--mute);
  font-size: 13px;
  background: #fff;
}
</style>
