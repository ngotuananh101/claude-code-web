/**
 * The runner registry's HTTP half (§6.1, §5.2): who exists, and — for a live
 * runner — which models its Claude Code offers.
 *
 * The model list is what the composer's picker is built from. An offline
 * runner answers with none: absence means "unknown", never "nothing to run",
 * so the picker falls back to the protocol's own list rather than going empty.
 */

import type { RunnerModel } from "@cc-web/protocol";
import { authFetch } from "./auth-api.ts";

export type OwnerRunner = {
  runnerId: string;
  revokedAt: number | null;
  /** The models this runner's Claude Code advertised; empty when unknown. */
  models: RunnerModel[];
};

export type RunnersResult =
  | { ok: true; runners: OwnerRunner[] }
  | { ok: false; reason: "unauthorized" | "error" };

export async function fetchRunners(): Promise<RunnersResult> {
  let response: Response;
  try {
    response = await authFetch("/api/runners");
  } catch {
    return { ok: false, reason: "error" };
  }

  if (response.status === 401) return { ok: false, reason: "unauthorized" };
  if (!response.ok) return { ok: false, reason: "error" };

  const body = (await response.json()) as { runners: OwnerRunner[] };
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
