/**
 * Workspace id → path resolution for the daemon (§11.1 MVP).
 *
 * The full design binds workspaces through registration; until that surface
 * exists, the operator declares one directory in the environment and every
 * dispatch that names the default workspace lands there. Anything else the
 * resolver does not know stays `undefined`, which the run controller turns
 * into an `unknown_workspace` refusal rather than a guess.
 */

/**
 * Build a resolver from `CC_WEB_RUNNER_DEFAULT_WORKSPACE`'s value. A blank
 * value disables the bridge entirely — an empty string is not a path anyone
 * meant to hand out.
 */
export function defaultWorkspaceResolver(
  env: string | undefined,
): (workspaceId: string) => string | undefined {
  const path = env?.trim();
  if (path === undefined || path === "") return () => undefined;
  return (workspaceId) => (workspaceId === "default" ? path : undefined);
}
