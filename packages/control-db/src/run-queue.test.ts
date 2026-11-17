import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate } from "./db.ts";
import { queuedRunsForSession } from "./run-queue.ts";

test("lists one session's queued runs with display fields only, oldest first", () => {
  const db = new Database(":memory:");
  migrate(db);

  const insert = db.prepare(
    `INSERT INTO command_outbox
       (command_id, runner_id, kind, payload, fingerprint, issued_at,
        session_id, run_id, attempt_id, delivery_state, attempt_count,
        requeue_count, created_at)
     VALUES (?, ?, 'run.start', ?, ?, '2026-10-24T00:00:00.000Z',
             ?, ?, ?, ?, 0, 0, ?)`,
  );

  // Two queued run.start rows for session-1 (created_at forced to 2 and 1), one accepted.
  insert.run(
    "cmd-b",
    "runner-a",
    JSON.stringify({ prompt: "second", profile: { apiKey: "secret" } }),
    "fp-b",
    "session-1",
    "run-b",
    "attempt-b",
    "queued",
    2,
  );
  insert.run(
    "cmd-a",
    "runner-a",
    JSON.stringify({ prompt: "first", profile: { apiKey: "secret" } }),
    "fp-a",
    "session-1",
    "run-a",
    "attempt-a",
    "queued",
    1,
  );
  insert.run(
    "cmd-c",
    "runner-a",
    JSON.stringify({ prompt: "accepted" }),
    "fp-c",
    "session-1",
    "run-c",
    "attempt-c",
    "accepted",
    0,
  );

  expect(queuedRunsForSession(db, "session-1")).toEqual([
    { runId: "run-a", attemptId: "attempt-a", prompt: "first", enqueuedAt: 1 },
    { runId: "run-b", attemptId: "attempt-b", prompt: "second", enqueuedAt: 2 },
  ]);
});
