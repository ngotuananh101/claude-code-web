<script setup lang="ts">
import { Toaster } from "@/components/ui/sonner";
import { startStore } from "./stores/sessions.ts";

startStore();
</script>

<template>
  <router-view />
  <!-- <html> carries .dark from the OS scheme; "system" keeps toasts in step.
       Top-center: the composer owns the bottom of the screen, and a bottom
       toast covers its Dừng/Gửi buttons for as long as it lives. -->
  <Toaster theme="system" position="top-center" />
</template>
