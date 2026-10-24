import { createRouter, createWebHistory } from "vue-router";
import { loadSessions } from "./stores/sessions.ts";

/**
 * The journal, the runners console and the login. The guard is the only
 * auth check the client makes — the cookie is HttpOnly, so "am I signed in?"
 * can only be asked by calling the server (§19.1) and reading the status.
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: () => import("./views/SessionView.vue") },
    { path: "/runners", component: () => import("./views/RunnersView.vue") },
    { path: "/login", component: () => import("./views/LoginView.vue") },
  ],
});

router.beforeEach(async (to) => {
  // The login route must not probe: an unauthorized visitor landing on it
  // would have the guard redirect to /login from /login, forever.
  if (to.path === "/login") return true;
  const authorized = await loadSessions();
  return authorized ? true : "/login";
});
