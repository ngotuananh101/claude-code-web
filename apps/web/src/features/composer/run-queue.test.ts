import { describe, expect, test } from "bun:test";
import { pruneQueuedRuns } from "./run-queue.ts";

/**
 * Pure pruning of the optimistic queue: a run leaves the waiting list the
 * moment its `run.started` event arrives; every other event leaves it alone.
 */

const a = { runId: "run-a", attemptId: "attempt-a", prompt: "A", enqueuedAt: 1 };
const b = { runId: "run-b", attemptId: "attempt-b", prompt: "B", enqueuedAt: 2 };

describe("pruneQueuedRuns", () => {
  test("pruning drops a run once its run.started arrives", () => {
    expect(pruneQueuedRuns([a, b], [{ type: "run.started", runId: "run-a" }])).toEqual([b]);
  });

  test("other event types leave the queue alone", () => {
    const events = [
      { type: "run.queued", runId: "run-a" },
      { type: "run.finished", runId: "run-a" },
      { type: "run.failed", runId: "run-a" },
      { type: "message.delta", runId: "run-a" },
    ];
    expect(pruneQueuedRuns([a, b], events)).toEqual([a, b]);
  });

  test("prunes multiple started runs and ignores unknown run ids", () => {
    const c = { runId: "run-c", attemptId: "attempt-c", prompt: "C", enqueuedAt: 3 };
    expect(
      pruneQueuedRuns(
        [a, b, c],
        [
          { type: "run.started", runId: "run-c" },
          { type: "run.started", runId: "run-missing" },
          { type: "run.started", runId: "run-a" },
        ],
      ),
    ).toEqual([b]);
  });
});
