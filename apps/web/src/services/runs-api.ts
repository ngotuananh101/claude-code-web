/**
 * The run surface's HTTP half (§17.1): submit a prompt, cancel a run.
 *
 * Pure mapping, no UI knowledge — which statuses collapse into which
 * operator-facing outcome is decided here so a component never parses a body
 * meant for a person. The prompt only ever travels in the request body; it
 * must never appear in a URL (§19.4).
 */

export type StartRunResult =
  | { ok: true; runId: string; attemptId: string; sessionId: string }
  | {
      ok: false;
      reason: "unauthorized" | "session_busy" | "session_pinned" | "runner_unavailable" | "error";
    };

/**
 * What the composer sends for one run. Every field but the prompt is absent
 * when the operator did not choose it — the body is built with conditional
 * spreads so the wire carries exactly the choices that were made (§8.1).
 */
export type StartRunRequest = {
  prompt: string;
  workspaceId?: string;
  runnerId?: string;
  permissionMode?: string;
  model?: string;
  /** The declared local head to check out before the run (M4). */
  branch?: string;
};

export async function startRun(sessionId: string, run: StartRunRequest): Promise<StartRunResult> {
  let response: Response;
  try {
    const body: Record<string, unknown> = { prompt: run.prompt };
    if (run.workspaceId !== undefined) body["workspaceId"] = run.workspaceId;
    if (run.runnerId !== undefined) body["runnerId"] = run.runnerId;
    if (run.permissionMode !== undefined) body["permissionMode"] = run.permissionMode;
    if (run.model !== undefined) body["model"] = run.model;
    if (run.branch !== undefined) body["branch"] = run.branch;
    response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, reason: "error" };
  }

  if (response.status === 401) return { ok: false, reason: "unauthorized" };
  if (response.status === 409) {
    // The route names the contradiction in the body: waiting for the active
    // run and "the session cannot move" are different messages to the operator.
    const pinned = (await response.text()).trim() === "session_pinned";
    return { ok: false, reason: pinned ? "session_pinned" : "session_busy" };
  }
  if (response.status === 503) return { ok: false, reason: "runner_unavailable" };
  if (!response.ok) return { ok: false, reason: "error" };

  const body = (await response.json()) as {
    runId: string;
    attemptId: string;
    sessionId: string;
  };
  return { ok: true, runId: body.runId, attemptId: body.attemptId, sessionId: body.sessionId };
}

export type CancelOutcome = "accepted" | "not_found" | "unauthorized" | "error";

export async function cancelRun(runId: string): Promise<CancelOutcome> {
  let response: Response;
  try {
    response = await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
    });
  } catch {
    return "error";
  }

  if (response.status === 202) return "accepted";
  if (response.status === 404) return "not_found";
  if (response.status === 401) return "unauthorized";
  return "error";
}
