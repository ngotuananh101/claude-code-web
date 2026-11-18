/**
 * Pure queue pruning: drops waiting runs once their `run.started` event
 * arrives. Other event types leave the queue unchanged.
 */

export type QueuedRun = {
  runId: string;
  attemptId: string;
  prompt: string;
  enqueuedAt: number;
};

export function pruneQueuedRuns(
  runs: QueuedRun[],
  events: Array<{ type: string; runId: string }>,
): QueuedRun[] {
  const startedRunIds = new Set<string>();
  for (const event of events) {
    if (event.type === "run.started") startedRunIds.add(event.runId);
  }
  if (startedRunIds.size === 0) return runs;
  return runs.filter((run) => !startedRunIds.has(run.runId));
}
