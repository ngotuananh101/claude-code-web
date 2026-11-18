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

/**
 * The reader backs GET /api/sessions/:id/queue, so a row it cannot parse must
 * still produce a list. A throw here is a 500 on a read that a user makes to
 * look at their own queue — the queue is durable and rows outlive the build
 * that wrote them, so a shape this code does not recognize has to degrade to
 * blank display fields, not to an error.
 */
test("a queued row with a payload it cannot read degrades to blank fields", () => {
  const db = new Database(":memory:");
  migrate(db);

  const insert = db.prepare(
    `INSERT INTO command_outbox
       (command_id, runner_id, kind, payload, fingerprint, issued_at,
        session_id, run_id, attempt_id, delivery_state, attempt_count,
        requeue_count, created_at)
     VALUES (?, 'runner-a', 'run.start', ?, ?, '2026-10-24T00:00:00.000Z',
             'session-1', ?, ?, 'queued', 0, 0, ?)`,
  );

  insert.run("cmd-broken", "{not json", "fp-1", "run-1", "attempt-1", 1);
  insert.run("cmd-shape", JSON.stringify({ profile: {} }), "fp-2", "run-2", "attempt-2", 2);
  // `run_id`/`attempt_id` are nullable in the table; the summary type is not.
  insert.run("cmd-null", JSON.stringify({ prompt: "hello" }), "fp-3", null, null, 3);

  expect(queuedRunsForSession(db, "session-1")).toEqual([
    { runId: "run-1", attemptId: "attempt-1", prompt: "", enqueuedAt: 1 },
    { runId: "run-2", attemptId: "attempt-2", prompt: "", enqueuedAt: 2 },
    { runId: "", attemptId: "", prompt: "hello", enqueuedAt: 3 },
  ]);
});
