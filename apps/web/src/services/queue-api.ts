/**
 * The session queue read: returns the waiting runs for a session in order.
 *
 * Pure mapping, no UI knowledge. Never throws: transport failures and
 * malformed bodies collapse into a generic outcome, and rows that are not
 * display-shaped are dropped so the composer never renders a blank entry.
 */

import { authFetch } from "./auth-api.ts";

export type QueuedRun = {
  runId: string;
  attemptId: string;
  prompt: string;
  /** Milliseconds since the epoch (`command_outbox.created_at`). */
  enqueuedAt: number;
};

export type FetchSessionQueueResult =
  | { ok: true; runs: QueuedRun[] }
  | { ok: false; reason: "unauthorized" | "error" };

function isQueuedRun(value: unknown): value is QueuedRun {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.runId === "string" &&
    typeof row.attemptId === "string" &&
    typeof row.prompt === "string" &&
    typeof row.enqueuedAt === "number" &&
    Number.isFinite(row.enqueuedAt)
  );
}

export async function fetchSessionQueue(sessionId: string): Promise<FetchSessionQueueResult> {
  let response: Response;
  try {
    response = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/queue`);
  } catch {
    return { ok: false, reason: "error" };
  }

  if (response.status === 401) return { ok: false, reason: "unauthorized" };
  if (!response.ok) return { ok: false, reason: "error" };

  try {
    const body = (await response.json()) as { runs?: unknown };
    const rawRuns = Array.isArray(body?.runs) ? body.runs : [];
    const runs = rawRuns.filter(isQueuedRun);
    return { ok: true, runs };
  } catch {
    return { ok: false, reason: "error" };
  }
}
