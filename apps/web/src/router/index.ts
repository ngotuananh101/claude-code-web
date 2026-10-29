import { createRouter, createWebHistory } from "vue-router";
import {
  fetchSetupStatus,
  startTokenRefreshTimer,
  stopTokenRefreshTimer,
} from "../services/auth-api.ts";
import { connectSocket, disconnectSocket, loadAccount, loadSessions } from "../stores/sessions.ts";
import { evaluateNavigation } from "./navigation-guard.ts";

/**
 * The console's pages behind one rail: the usage dashboard (the default
 * landing), the session workspace, and the runners console. The login route
 * stands alone — no rail before authentication. The guard is the only auth
 * check the client makes: the cookie is HttpOnly, so "am I signed in?" can
 * only be asked by calling the server (§19.1) and reading the status.
 *
 * The /setup route mirrors the front door on first deploy: before an owner
 * account exists, the server answers `setupRequired: true` and the guard
 * steers every visitor to /setup, never to /login.
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      component: () => import("../views/ConsoleLayout.vue"),
      children: [
        { path: "", name: "dashboard", component: () => import("../views/DashboardView.vue") },
        {
          path: "sessions/:sessionId?",
          name: "sessions",
          component: () => import("../views/SessionView.vue"),
        },
        { path: "runners", name: "runners", component: () => import("../views/RunnersView.vue") },
      ],
    },
    { path: "/login", component: () => import("../views/LoginView.vue") },
    { path: "/setup", component: () => import("../views/SetupView.vue") },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.beforeEach(async (to) => {
  // Probe authentication first (HttpOnly cookie → server round-trip), then
  // whether the owner account still needs seeding on an unauthenticated visit.
  const isAuthorized = await loadSessions();
  const isSetupRequired = !isAuthorized ? (await fetchSetupStatus()).setupRequired : false;

  const decision = evaluateNavigation({
    toPath: to.path,
    isAuthorized,
    isSetupRequired,
  });

  // The WebSocket follows the navigation: live while inside the authenticated
  // shell, closed for everything else. Token auto-refresh mirrors the same lifecycle.
  if (decision.socketAction === "connect") {
    connectSocket();
    startTokenRefreshTimer();
  } else {
    disconnectSocket();
    stopTokenRefreshTimer();
  }

  if (decision.redirect) {
    return decision.redirect;
  }

  // Past the gate: warm the account name for the rail footer.
  if (isAuthorized) {
    void loadAccount();
  }

  return true;
});
