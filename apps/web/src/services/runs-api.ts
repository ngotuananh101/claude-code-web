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
      reason: "unauthorized" | "session_busy" | "runner_unavailable" | "error";
    };

export async function startRun(
  sessionId: string,
  prompt: string,
  workspaceId?: string,
): Promise<StartRunResult> {
  let response: Response;
  try {
    response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(workspaceId ? { prompt, workspaceId } : { prompt }),
    });
  } catch {
    return { ok: false, reason: "error" };
  }

  if (response.status === 401) return { ok: false, reason: "unauthorized" };
  if (response.status === 409) return { ok: false, reason: "session_busy" };
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
