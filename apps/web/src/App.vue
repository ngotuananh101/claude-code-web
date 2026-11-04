<script setup lang="ts">
import { Toaster } from "@/components/ui/sonner";
import { useTheme } from "./lib/theme.ts";
import { startStore } from "./stores/sessions.ts";

const { resolvedTheme } = useTheme();

startStore();
</script>

<template>
  <router-view />
  <!-- <html> carries .dark from the active theme preference; resolvedTheme
       keeps toasts in step. Top-center: the composer owns the bottom of the
       screen, and a bottom toast covers its Dừng/Gửi buttons for as long as it
       lives. -->
  <Toaster :theme="resolvedTheme" position="top-center" />
</template>
