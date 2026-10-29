/**
 * The workspace registry's HTTP half (§15.1): the workspaces the runners
 * declared, which is what the composer offers as projects. Pure mapping like
 * runs-api — which statuses collapse into which operator-facing outcome is
 * decided here so a component never parses a body meant for a person.
 */

import { authFetch } from "./auth-api.ts";

export type OwnerWorkspace = {
  workspaceId: string;
  runnerId: string;
  path: string;
  /** The local heads the runner declared for this workspace (M4). */
  branches: string[];
  /** The branch HEAD pointed at when declared; null/absent = unknown. */
  currentBranch?: string | null;
  createdAt: number;
};

export type WorkspacesResult =
  | { ok: true; workspaces: OwnerWorkspace[] }
  | { ok: false; reason: "unauthorized" | "error" };

export async function fetchWorkspaces(): Promise<WorkspacesResult> {
  let response: Response;
  try {
    response = await authFetch("/api/workspaces");
  } catch {
    return { ok: false, reason: "error" };
  }

  if (response.status === 401) return { ok: false, reason: "unauthorized" };
  if (!response.ok) return { ok: false, reason: "error" };

  const body = (await response.json()) as { workspaces: OwnerWorkspace[] };
  return { ok: true, workspaces: body.workspaces };
}
