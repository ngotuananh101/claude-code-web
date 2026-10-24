/**
 * Web app entrypoint.
 *
 * Vue 3 + TypeScript + Vite. Fonts load here so every view below sees the
 * same two faces: Instrument Sans for the human voice, IBM Plex Mono for
 * the machine voice — the journal's sequence numbers, event types, payloads.
 */

import "@fontsource/instrument-sans/400.css";
import "@fontsource/instrument-sans/500.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles/tokens.css";
import "./styles/app.css";
import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router.ts";

createApp(App).use(router).mount("#app");
