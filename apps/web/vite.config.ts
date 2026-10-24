import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import ts5 from "typescript5";
import { defineConfig } from "vite";
import { registerTS } from "vue/compiler-sfc";

/**
 * The repo's TypeScript is v7 — the native port, whose JS surface carries no
 * API (`sys` and friends are gone). @vue/compiler-sfc resolves the shadcn-vue
 * components' imported `defineProps` types (reka-ui's `PrimitiveProps`,
 * `LabelProps`) through a full TypeScript JS module, so with only v7 present
 * every generated component failed to compile ("Failed to resolve extends
 * base type") in both `vite dev` and `vite build`. `registerTS` is the
 * compiler's official injection point for that module: hand it the JS
 * TypeScript 5 distribution, aliased as `typescript5` in the root
 * package.json so the v7 binary used by `tsc -b` is untouched.
 */
type CompilerTs = Parameters<typeof registerTS>[0] extends () => infer T ? T : never;
registerTS((): CompilerTs => ts5 as unknown as CompilerTs);

/**
 * The dev server fronts the control server: `/auth` (login/logout) and `/api`
 * are plain HTTP proxying, `/ws/browser` needs `ws: true` so the upgrade
 * reaches the socket rather than being answered as a request. The upstream is
 * the control server's fixed dev port (CC_WEB_PORT, default 8787).
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
