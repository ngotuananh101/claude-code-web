import { createRouter, createWebHistory } from "vue-router";
import { loadSessions } from "./stores/sessions.ts";

/**
 * The console's pages behind one rail: the usage dashboard (the default
 * landing), the session workspace, and the runners console. The login route
 * stands alone — no rail before authentication. The guard is the only auth
 * check the client makes: the cookie is HttpOnly, so "am I signed in?" can
 * only be asked by calling the server (§19.1) and reading the status.
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      component: () => import("./views/ConsoleLayout.vue"),
      children: [
        { path: "", name: "dashboard", component: () => import("./views/DashboardView.vue") },
        {
          path: "sessions/:sessionId?",
          name: "sessions",
          component: () => import("./views/SessionView.vue"),
        },
        { path: "runners", name: "runners", component: () => import("./views/RunnersView.vue") },
      ],
    },
    { path: "/login", component: () => import("./views/LoginView.vue") },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.beforeEach(async (to) => {
  // The login route must not probe: an unauthorized visitor landing on it
  // would have the guard redirect to /login from /login, forever.
  if (to.path === "/login") return true;
  const authorized = await loadSessions();
  return authorized ? true : "/login";
});
