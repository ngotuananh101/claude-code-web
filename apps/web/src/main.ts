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
import { router } from "./router/index.ts";

// The generated theme defines a .dark palette; follow the OS preference so
// both palettes apply without an in-app toggle.
const scheme = window.matchMedia("(prefers-color-scheme: dark)");
const applyScheme = (): void => {
  document.documentElement.classList.toggle("dark", scheme.matches);
};
applyScheme();
scheme.addEventListener("change", applyScheme);

createApp(App).use(router).mount("#app");
