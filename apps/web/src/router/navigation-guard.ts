/**
 * Navigation guard evaluation (§19.1, Task 4).
 *
 * A pure rule table for route transitions, given the three facts the router
 * can assemble before a navigation resolves:
 * - `toPath`: the destination path being navigated to.
 * - `isAuthorized`: whether the session cookie is valid (loadSessions).
 * - `isSetupRequired`: whether the owner account still needs seeding.
 *
 * The decision carries one of three outcomes:
 * - `redirect`: a path to replace the navigation target (auth/setup gating).
 * - `allow`: whether the router proceeds to the route (true) or blocks it.
 * - `socketAction`: "connect" (authenticated shell) or "disconnect"
 *   (anything that is not an authenticated shell) so the WebSocket follows
 *   the user out of /setup, through /login, and into the console rail.
 */

export type NavigationDecision = {
  redirect?: string;
  allow: boolean;
  socketAction: "connect" | "disconnect";
};

export type NavigationParams = {
  toPath: string;
  isAuthorized: boolean;
  isSetupRequired: boolean;
};

/**
 * Evaluate a route transition and produce the guard decision.
 *
 * Rule table (first match wins):
 * 1. Setup required -> everything routes through /setup, except /setup itself
 *    which is allowed (it is the destination). The socket disconnects on every
 *    branch because there is no authenticated shell yet.
 * 2. Authorized -> /login bounces to the console ("/"); every other path keeps
 *    the socket connected (entering the authenticated shell).
 * 3. Unauthorized (setup not required) -> /login and /setup are allowed as
 *    public doorways; everything else bounces to /login and the socket
 *    disconnects (no authenticated shell).
 */
export function evaluateNavigation(params: NavigationParams): NavigationDecision {
  const { toPath, isAuthorized, isSetupRequired } = params;

  // 1. First-time setup is pending: the front door is /setup.
  if (isSetupRequired) {
    if (toPath === "/setup") {
      return { allow: true, socketAction: "disconnect" };
    }
    return { redirect: "/setup", allow: false, socketAction: "disconnect" };
  }

  // 2. Authenticated: the console rail is open, the socket is live.
  if (isAuthorized) {
    if (toPath === "/login" || toPath === "/setup") {
      return { redirect: "/", allow: false, socketAction: "connect" };
    }
    return { allow: true, socketAction: "connect" };
  }

  // 3. Unauthorized (setup not required): /login is the only public doorway;
  //    /setup has no meaning here (setup is done) so it bounces too. The
  //    socket disconnects in every branch — no authenticated shell yet.
  if (toPath === "/login") {
    return { allow: true, socketAction: "disconnect" };
  }
  return { redirect: "/login", allow: false, socketAction: "disconnect" };
}
