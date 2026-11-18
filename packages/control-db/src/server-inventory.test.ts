import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate } from "./db.ts";
import { serverRunsForRunner } from "./server-inventory.ts";

function seeded(): Database {
  const db = new Database(":memory:");
  migrate(db);
  db.query("INSERT INTO runners (id, owner_id, created_at) VALUES (?, ?, ?)").run(
    "runner-a",
    "owner-1",
    1,
  );
  return db;
}

function activeRun(
  db: Database,
  row: { runId: string; sessionId?: string; runnerId?: string; attemptId: string; at?: number },
): void {
  db.query(
    "INSERT INTO active_runs (run_id, session_id, runner_id, attempt_id, dispatched_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    row.runId,
    row.sessionId ?? `session-${row.runId}`,
    row.runnerId ?? "runner-a",
    row.attemptId,
    row.at ?? 1,
  );
}

test("lists a runner's active runs as running, oldest dispatch first", () => {
  const db = seeded();
  activeRun(db, { runId: "run-b", attemptId: "attempt-b", at: 2 });
  activeRun(db, { runId: "run-a", attemptId: "attempt-a", at: 1 });
  activeRun(db, { runId: "run-other", attemptId: "attempt-other", runnerId: "runner-b", at: 0 });

  expect(serverRunsForRunner(db, "runner-a")).toEqual([
    { runId: "run-a", attemptId: "attempt-a", state: "running", cancelRequested: false },
    { runId: "run-b", attemptId: "attempt-b", state: "running", cancelRequested: false },
  ]);
});

test("a pending approval reports waiting_for_approval so the abandoned-gate branch fires", () => {
  const db = seeded();
  activeRun(db, { runId: "run-1", attemptId: "attempt-1" });
  db.query(
    `INSERT INTO approvals
       (approval_id, session_id, run_id, attempt_id, runner_id, kind, tool_name,
        input_hash, input_summary, expires_at, state, created_at)
     VALUES ('approval-1', 'session-run-1', 'run-1', 'attempt-1', 'runner-a',
             'tool_permission', 'Bash', 'hash', 'run tests', 0, 'pending', 1)`,
  ).run();

  expect(serverRunsForRunner(db, "runner-a")).toEqual([
    {
      runId: "run-1",
      attemptId: "attempt-1",
      state: "waiting_for_approval",
      cancelRequested: false,
    },
  ]);
});

test("a settled approval does not keep the run parked", () => {
  const db = seeded();
  activeRun(db, { runId: "run-1", attemptId: "attempt-1" });
  db.query(
    `INSERT INTO approvals
       (approval_id, session_id, run_id, attempt_id, runner_id, kind, tool_name,
        input_hash, input_summary, expires_at, state, created_at)
     VALUES ('approval-1', 'session-run-1', 'run-1', 'attempt-1', 'runner-a',
             'tool_permission', 'Bash', 'hash', 'run tests', 0, 'resolved', 1)`,
  ).run();

  expect(serverRunsForRunner(db, "runner-a")[0]?.state).toBe("running");
});

test("a live run.cancel carries its own command id for the re-send (§14.2)", () => {
  const db = seeded();
  activeRun(db, { runId: "run-1", attemptId: "attempt-1" });
  db.query(
    `INSERT INTO command_outbox
       (command_id, runner_id, kind, payload, fingerprint, issued_at, session_id,
        run_id, attempt_id, delivery_state, attempt_count, requeue_count, created_at)
     VALUES ('cmd-cancel', 'runner-a', 'run.cancel', '{}', 'fp', '2026-11-18T00:00:00.000Z',
             'session-run-1', 'run-1', 'attempt-1', 'sent', 1, 0, 2)`,
  ).run();

  expect(serverRunsForRunner(db, "runner-a")).toEqual([
    {
      runId: "run-1",
      attemptId: "attempt-1",
      state: "running",
      cancelRequested: true,
      cancelCommandId: "cmd-cancel",
    },
  ]);
});

test("a rejected cancel is not re-sent", () => {
  const db = seeded();
  activeRun(db, { runId: "run-1", attemptId: "attempt-1" });
  db.query(
    `INSERT INTO command_outbox
       (command_id, runner_id, kind, payload, fingerprint, issued_at, session_id,
        run_id, attempt_id, delivery_state, attempt_count, requeue_count, created_at)
     VALUES ('cmd-cancel', 'runner-a', 'run.cancel', '{}', 'fp', '2026-11-18T00:00:00.000Z',
             'session-run-1', 'run-1', 'attempt-1', 'rejected', 1, 0, 2)`,
  ).run();

  const run = serverRunsForRunner(db, "runner-a")[0];
  expect(run?.cancelRequested).toBe(false);
  // Absent, not `undefined`: the reconcile input must not carry a cancel id
  // for a command that will never be re-sent.
  expect(run === undefined ? true : "cancelCommandId" in run).toBe(false);
});

test("an empty runner has an empty inventory", () => {
  expect(serverRunsForRunner(seeded(), "runner-a")).toEqual([]);
});
