import { createRouter, createWebHistory } from "vue-router";
import { loadSessions } from "./stores/sessions.ts";

/**
 * Two routes for now: the journal and the login. The guard is the only
 * auth check the client makes — the cookie is HttpOnly, so "am I signed in?"
 * can only be asked by calling the server (§19.1) and reading the status.
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: () => import("./views/SessionView.vue") },
    { path: "/login", component: () => import("./views/LoginView.vue") },
  ],
});

router.beforeEach(async () => {
  const authorized = await loadSessions();
  return authorized ? true : "/login";
});
