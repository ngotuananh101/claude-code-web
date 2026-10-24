/**
 * Web app entrypoint.
 *
 * Vue 3 + TypeScript + Vite. The theme comes entirely from the generated
 * styles/index.css (shadcn-vue); the only font loaded here is the Inter
 * variable face that font-sans declares.
 */

import "./styles/index.css";
import "@fontsource-variable/inter";
import "./styles/app.css";
import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router.ts";

createApp(App).use(router).mount("#app");
