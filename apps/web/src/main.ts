/**
 * Web app entrypoint.
 *
 * Vue 3 + TypeScript + Vite. The theme comes entirely from the generated
 * styles/index.css (shadcn-vue); the only font loaded here is the Figtree
 * variable face that font-sans declares.
 */

import "./styles/index.css";
import "@fontsource-variable/figtree";
import "./styles/app.css";
// The generated ui/sonner wrapper must stay untouched, so the entrypoint owns
// vue-sonner's stylesheet — without it toasts render unstyled.
import "vue-sonner/style.css";
import { createApp } from "vue";
import App from "./App.vue";
import { initTheme } from "./lib/theme.ts";
import { router } from "./router/index.ts";

// Syncs <html> with the saved theme preference ("light" | "dark" | "system",
// defaulting to "system") and listens for OS color-scheme changes.
initTheme();

createApp(App).use(router).mount("#app");
