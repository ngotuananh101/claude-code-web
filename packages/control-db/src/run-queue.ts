import type { Database } from "bun:sqlite";

export type QueuedRunSummary = {
  runId: string;
  attemptId: string;
  prompt: string;
  enqueuedAt: number;
};

export function queuedRunsForSession(db: Database, sessionId: string): QueuedRunSummary[] {
  const rows = db
    .prepare(
      `SELECT command_id, run_id, attempt_id, payload, created_at
       FROM command_outbox
       WHERE session_id = ?
         AND kind = 'run.start'
         AND delivery_state = 'queued'
       ORDER BY created_at ASC, command_id ASC`,
    )
    .all(sessionId) as Array<{
    command_id: string;
    run_id: string | null;
    attempt_id: string | null;
    payload: string;
    created_at: number;
  }>;

  return rows.map((row) => {
    let prompt = "";
    try {
      const parsed = JSON.parse(row.payload) as { prompt?: unknown } | null;
      if (parsed && typeof parsed.prompt === "string") {
        prompt = parsed.prompt;
      }
    } catch {
      prompt = "";
    }
    return {
      runId: row.run_id ?? "",
      attemptId: row.attempt_id ?? "",
      prompt,
      enqueuedAt: row.created_at,
    };
  });
}
