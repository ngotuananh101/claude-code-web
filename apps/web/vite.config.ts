import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

/**
 * The dev server fronts the control server: `/auth` and `/api` are plain HTTP
 * proxying, `/ws/browser` needs `ws: true` so the upgrade reaches the socket
 * rather than being answered as a request. The upstream is the control
 * server's fixed dev port (CC_WEB_PORT, default 8787).
 */
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/auth": "http://127.0.0.1:8787",
      "/api": "http://127.0.0.1:8787",
      "/ws/browser": {
        target: "ws://127.0.0.1:8787",
        ws: true,
      },
    },
  },
});
