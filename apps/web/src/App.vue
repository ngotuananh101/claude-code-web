<script setup lang="ts">
import { Toaster } from "@/components/ui/sonner";
import { startStore } from "./stores/sessions.ts";

startStore();
</script>

<template>
  <router-view />
  <!-- <html> carries .dark from the OS scheme; "system" keeps toasts in step. -->
  <Toaster theme="system" />
</template>
