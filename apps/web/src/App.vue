<script setup lang="ts">
import { startStore } from "./stores/sessions.ts";

startStore();
</script>

<template>
  <router-view />
</template>
