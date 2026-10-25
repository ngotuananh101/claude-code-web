import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { approvalForSession, migrate } from "@cc-web/control-db";
import { type RunnerEvent, RunRegistry } from "@cc-web/protocol";
import { projectApprovalEvent } from "./ingest.ts";

/**
 * Projecting approval events out of the journal (§13.1).
 *
 * The runner's gate emits `approval.*` events; this hook is what turns them
 * into the control plane's durable projection — the row a decision route
 * answers from, and the registry transition the reconcile inventory reports.
 * It runs after `ingestEvent` for every event, duplicates included: the
 * projection writes are idempotent, so a redelivered event heals a projection
 * a crash skipped instead of corrupting one.
 */

function setup(): { db: Database; runs: RunRegistry } {
  const db = new Database(":memory:");
  migrate(db);
  const runs = new RunRegistry();
  runs.createRun({
    runId: "run-1",
    attemptId: "attempt-1",
    sessionId: "session-1",
    runnerId: "runner-a",
  });
  return { db, runs };
}

let eventNo = 0;
function approvalEvent(
  type: RunnerEvent["type"],
  payload: Record<string, unknown>,
  overrides: Partial<RunnerEvent> = {},
): RunnerEvent {
  eventNo += 1;
  return {
    protocolVersion: 1,
    eventId: `evt-${eventNo}`,
    runnerId: "runner-a",
    bootId: "boot-1",
    sessionId: "session-1",
    runId: "run-1",
    attemptId: "attempt-1",
    localSequence: eventNo,
    occurredAt: new Date(1_000).toISOString(),
    type,
    payload,
    ...overrides,
  };
}

const TOOL_REQUEST = {
  approvalId: "apr-1",
  toolCallId: "tc-1",
  inputHash: "hash-1",
  callbackGeneration: 0,
  kind: "tool_permission",
  toolName: "Bash",
  expiresAt: 61_000,
  inputSummary: "ls -la",
};

describe("projectApprovalEvent", () => {
  test("projects approval.requested into a pending row and suspends the run", () => {
    const { db, runs } = setup();

    projectApprovalEvent(db, runs, approvalEvent("approval.requested", TOOL_REQUEST));

    const row = approvalForSession(db, "apr-1");
    expect(row).toMatchObject({
      sessionId: "session-1",
      runnerId: "runner-a",
      state: "pending",
      kind: "tool_permission",
      toolName: "Bash",
      inputHash: "hash-1",
      inputSummary: "ls -la",
      expiresAt: 61_000,
    });
    expect(runs.get("run-1")?.observedState).toBe("waiting_for_approval");
  });

  test("a user_question stores the redacted questions JSON as its summary", () => {
    const { db, runs } = setup();
    const questions = [
      { question: "Chạy migration?", header: "Deploy", options: [{ label: "Có" }] },
    ];

    projectApprovalEvent(
      db,
      runs,
      approvalEvent("approval.requested", {
        ...TOOL_REQUEST,
        kind: "user_question",
        toolName: "AskUserQuestion",
        inputSummary: undefined,
        questions,
      }),
    );

    const row = approvalForSession(db, "apr-1");
    expect(row?.kind).toBe("user_question");
    expect(JSON.parse(row?.inputSummary ?? "")).toEqual(questions);
    expect(runs.get("run-1")?.observedState).toBe("waiting_for_approval");
  });

  test("a replayed requested event leaves one pending row (at-least-once is safe)", () => {
    const { db, runs } = setup();
    const event = approvalEvent("approval.requested", TOOL_REQUEST);

    projectApprovalEvent(db, runs, event);
    projectApprovalEvent(db, runs, event);

    const rows = db
      .prepare("SELECT approval_id FROM approvals WHERE approval_id = 'apr-1'")
      .all() as unknown[];
    expect(rows).toHaveLength(1);
    expect(approvalForSession(db, "apr-1")?.state).toBe("pending");
    expect(runs.get("run-1")?.observedState).toBe("waiting_for_approval");
  });

  test("approval.resolved closes the row resolved and resumes the run", () => {
    const { db, runs } = setup();
    projectApprovalEvent(db, runs, approvalEvent("approval.requested", TOOL_REQUEST));

    projectApprovalEvent(
      db,
      runs,
      approvalEvent("approval.resolved", {
        approvalId: "apr-1",
        decision: "allow",
        source: "user",
      }),
    );

    expect(approvalForSession(db, "apr-1")?.state).toBe("resolved");
    expect(runs.get("run-1")?.observedState).toBe("running");
  });

  test("approval.expired closes the row expired and resumes the run", () => {
    const { db, runs } = setup();
    projectApprovalEvent(db, runs, approvalEvent("approval.requested", TOOL_REQUEST));

    projectApprovalEvent(
      db,
      runs,
      approvalEvent("approval.expired", { approvalId: "apr-1", reason: "timeout" }),
    );

    expect(approvalForSession(db, "apr-1")?.state).toBe("expired");
    expect(runs.get("run-1")?.observedState).toBe("running");
  });

  test("a malformed requested payload is dropped, not stored", () => {
    const { db, runs } = setup();

    projectApprovalEvent(
      db,
      runs,
      approvalEvent("approval.requested", { approvalId: "", toolName: 42 }),
    );

    const rows = db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number };
    expect(rows.n).toBe(0);
    expect(runs.get("run-1")?.observedState).toBeUndefined();
  });

  test("non-approval events are ignored", () => {
    const { db, runs } = setup();

    projectApprovalEvent(
      db,
      runs,
      approvalEvent("run.started", { workspacePath: "/home/runner/project" }),
    );

    const rows = db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number };
    expect(rows.n).toBe(0);
    expect(runs.get("run-1")?.observedState).toBeUndefined();
  });

  test("an approval for an unknown run suspends nothing", () => {
    const db = new Database(":memory:");
    migrate(db);
    const runs = new RunRegistry();

    projectApprovalEvent(db, runs, approvalEvent("approval.requested", TOOL_REQUEST));

    expect(approvalForSession(db, "apr-1")?.state).toBe("pending");
    expect(runs.get("run-1")).toBeUndefined();
  });
});
