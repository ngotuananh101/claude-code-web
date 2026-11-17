/**
 * The runner registry's HTTP half (§6.1, §5.2): who exists, and — for a live
 * runner — which models its Claude Code offers and which commands, plugins,
 * MCP servers and agents it discovered at boot.
 *
 * The model list is what the composer's picker is built from. An offline
 * runner answers with none: absence means "unknown", never "nothing to run",
 * so the picker falls back to the protocol's own list rather than going empty.
 */

import type { RunnerCapabilities, RunnerModel } from "@cc-web/protocol";
import { runnerNames } from "../stores/runner-names.ts";
import { authFetch } from "./auth-api.ts";

// A late listing must not undo a rename or a newer registry response.
let runnerNamesRevision = 0;

export type OwnerRunner = {
  runnerId: string;
  name?: string | null;
  revokedAt: number | null;
  /** The models this runner's Claude Code advertised; empty when unknown. */
  models: RunnerModel[];
  /**
   * The commands, plugins, MCP servers and agents this runner's Claude Code
   * discovered at boot — the composer's slash-command catalogue. Absent when
   * the runner is offline or predates discovery; like `models`, absence means
   * "unknown", never "nothing to offer".
   */
  capabilities?: RunnerCapabilities;
};

export type RunnersResult =
  | { ok: true; runners: OwnerRunner[] }
  | { ok: false; reason: "unauthorized" | "error" };

/**
 * The rail's headings and chips read this registry mirror. A later response
 * replaces it, so a deleted runner cannot keep a stale label; a failed request
 * publishes nothing, leaving the last known good names in place.
 */
function publishRunnerNames(runners: readonly OwnerRunner[]): void {
  runnerNamesRevision += 1;
  runnerNames.clear();
  for (const runner of runners) {
    const name = typeof runner.name === "string" ? runner.name.trim() : "";
    runnerNames.set(runner.runnerId, name === "" ? null : name);
  }
}

export async function fetchRunners(): Promise<RunnersResult> {
  const startedAt = runnerNamesRevision;
  let response: Response;
  try {
    response = await authFetch("/api/runners");
  } catch {
    return { ok: false, reason: "error" };
  }

  if (response.status === 401) return { ok: false, reason: "unauthorized" };
  if (!response.ok) return { ok: false, reason: "error" };

  const body = (await response.json()) as { runners: OwnerRunner[] };
  // A rename that landed while this listing was in flight is newer than the
  // listing's snapshot; publishing it would flip the rail back to the old name.
  if (runnerNamesRevision === startedAt) publishRunnerNames(body.runners);
  return { ok: true, runners: body.runners };
}

/** The live runners an operator may pick — a revoked one is as good as gone. */
export function liveRunners(runners: readonly OwnerRunner[]): OwnerRunner[] {
  return runners.filter((runner) => runner.revokedAt === null);
}

/** One runner's advertised models, or `[]` when it advertises none/unknown. */
export function modelsOfRunner(runners: readonly OwnerRunner[], runnerId: string): RunnerModel[] {
  return runners.find((runner) => runner.runnerId === runnerId)?.models ?? [];
}

/**
 * Rename a runner. The rail and the composer read the same registry mirror, so
 * a successful PATCH publishes the trimmed name (or null when cleared) at once
 * instead of waiting for the console's next listing.
 */
export async function renameRunner(runnerId: string, name: string): Promise<boolean> {
  let response: Response;
  try {
    response = await authFetch(`/api/runners/${encodeURIComponent(runnerId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  const trimmed = name.trim();
  runnerNamesRevision += 1;
  runnerNames.set(runnerId, trimmed === "" ? null : trimmed);
  return true;
}

/**
 * Delete a runner and cascade delete all its associated sessions.
 */
export async function deleteRunner(
  runnerId: string,
): Promise<{ ok: boolean; runnerId?: string | undefined; deletedSessions?: string[] | undefined }> {
  try {
    const response = await authFetch(`/api/runners/${encodeURIComponent(runnerId)}`, {
      method: "DELETE",
    });
    if (!response.ok) return { ok: false };
    const body = (await response.json()) as {
      ok: boolean;
      runnerId?: string;
      deletedSessions?: string[];
    };
    return {
      ok: body.ok ?? true,
      runnerId: body.runnerId ?? runnerId,
      deletedSessions: body.deletedSessions,
    };
  } catch {
    return { ok: false };
  }
}
