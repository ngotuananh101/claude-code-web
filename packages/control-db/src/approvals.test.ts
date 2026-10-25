import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "./db.ts";
import { CommandOutbox, fingerprintOf } from "./command-outbox.ts";
import {
  approvalForSession,
  closeApproval,
  recordApprovalDecision,
  upsertApprovalRequested,
} from "./approvals.ts";

/**
 * The server-side approvals projection (§13).
 *
 * A decision and the command that carries it to the runner must commit in ONE
 * transaction: a decision accepted by the server but whose command row never
 * existed would strand the operator's card in "đang chuyển quyết định" forever.
 * The CAS (`pending → decided`) is also the once-guard — a replayed or
 * double-submitted decision answers `not_pending` instead of writing a second
 * command.
 */

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

const requested = {
  approvalId: "apr-1",
  sessionId: "session-1",
  runId: "run-1",
  attemptId: "attempt-1",
  runnerId: "runner-a",
  kind: "tool_permission" as const,
  toolName: "Bash",
  inputHash: "hash-1",
  inputSummary: "ls -la",
  expiresAt: 1_000,
};

describe("the approvals schema", () => {
  test("migrate creates both tables", () => {
    const db = setup();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'approval%'")
      .all() as Array<{ name: string }>;

    expect(tables.map((t) => t.name).sort()).toEqual(["approval_decisions", "approvals"]);
  });
});

describe("upsertApprovalRequested", () => {
  test("inserts one pending row and is replay-idempotent", () => {
    const db = setup();

    upsertApprovalRequested(db, { ...requested, now: 900 });
    upsertApprovalRequested(db, { ...requested, now: 900 });

    const rows = db.prepare("SELECT * FROM approvals").all();
    expect(rows).toHaveLength(1);

    const record = approvalForSession(db, "apr-1");
    expect(record).toEqual({
      sessionId: "session-1",
      runnerId: "runner-a",
      state: "pending",
      inputHash: "hash-1",
      kind: "tool_permission",
      toolName: "Bash",
      inputSummary: "ls -la",
      expiresAt: 1_000,
    });
  });
});

describe("recordApprovalDecision", () => {
  test("answers unknown for an approval it never projected", () => {
    const db = setup();

    const result = recordApprovalDecision(db, {
      approvalId: "missing",
      decision: "allow",
      outbox: { commandId: "cmd-1", fingerprint: "fp-1" },
    });

    expect(result).toEqual({ ok: false, reason: "unknown" });
  });

  test("commits the decision row and the outbox command in one transaction", () => {
    const db = setup();
    upsertApprovalRequested(db, requested);

    const result = recordApprovalDecision(db, {
      approvalId: "apr-1",
      decision: "deny",
      answersJson: JSON.stringify([{ question: "why", answer: "no" }]),
      outbox: { commandId: "cmd-1", fingerprint: "fp-1" },
      now: 1_100,
    });

    expect(result).toEqual({
      ok: true,
      runnerId: "runner-a",
      inputHash: "hash-1",
      sessionId: "session-1",
    });

    const approval = db
      .prepare("SELECT state FROM approvals WHERE approval_id = ?")
      .get("apr-1") as { state: string };
    expect(approval.state).toBe("decided");

    const decisions = db
      .prepare("SELECT approval_id, decision, answers_json, decided_at FROM approval_decisions")
      .all() as Array<{ approval_id: string; decision: string; answers_json: string; decided_at: number }>;
    expect(decisions).toEqual([
      { approval_id: "apr-1", decision: "deny", answers_json: '[{"question":"why","answer":"no"}]', decided_at: 1_100 },
    ]);

    const commands = new CommandOutbox(db).pendingFor("runner-a");
    expect(commands).toHaveLength(1);
    expect(commands[0]!.kind).toBe("approval.respond");
    expect(commands[0]!.commandId).toBe("cmd-1");
    expect(commands[0]!.sessionId).toBe("session-1");
    expect(commands[0]!.runId).toBe("run-1");
    expect(commands[0]!.attemptId).toBe("attempt-1");
    const outboxRow = db
      .prepare("SELECT fingerprint FROM command_outbox WHERE command_id = ?")
      .get("cmd-1") as { fingerprint: string };
    expect(outboxRow.fingerprint).toBe("fp-1");
    expect(commands[0]!.payload).toEqual({
      approvalId: "apr-1",
      decision: "deny",
      answers: [{ question: "why", answer: "no" }],
      inputHash: "hash-1",
    });
  });

  test("refuses a second decision — the CAS is the once-guard", () => {
    const db = setup();
    upsertApprovalRequested(db, requested);
    const first = recordApprovalDecision(db, {
      approvalId: "apr-1",
      decision: "allow",
      outbox: { commandId: "cmd-1", fingerprint: "fp-1" },
    });
    const second = recordApprovalDecision(db, {
      approvalId: "apr-1",
      decision: "deny",
      outbox: { commandId: "cmd-2", fingerprint: "fp-2" },
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "not_pending" });

    const commands = new CommandOutbox(db).pendingFor("runner-a");
    expect(commands).toHaveLength(1);
    expect(commands[0]!.commandId).toBe("cmd-1");
  });

  test("fingerprintOf is exported and hashes the envelope identity", async () => {
    const fp = await fingerprintOf({
      commandId: "cmd-1",
      runnerId: "runner-a",
      kind: "approval.respond",
      payload: { approvalId: "apr-1" },
      issuedAt: "2026-10-25T00:00:00.000Z",
    });

    expect(typeof fp).toBe("string");
    expect(fp.length).toBeGreaterThan(0);
  });
});

describe("closeApproval", () => {
  test("closes a pending approval once and refuses terminal states", () => {
    const db = setup();
    upsertApprovalRequested(db, requested);

    expect(closeApproval(db, { approvalId: "apr-1", state: "resolved", now: 1_200 })).toBe(true);
    expect(closeApproval(db, { approvalId: "apr-1", state: "resolved", now: 1_200 })).toBe(false);
    expect(approvalForSession(db, "apr-1")?.state).toBe("resolved");
  });

  test("closes from decided — the runner outcome arrives after the decision", () => {
    const db = setup();
    upsertApprovalRequested(db, requested);
    recordApprovalDecision(db, {
      approvalId: "apr-1",
      decision: "allow",
      outbox: { commandId: "cmd-1", fingerprint: "fp-1" },
    });

    expect(closeApproval(db, { approvalId: "apr-1", state: "resolved", now: 1_200 })).toBe(true);
    expect(approvalForSession(db, "apr-1")?.state).toBe("resolved");
  });

  test("answers false for an unknown approval", () => {
    const db = setup();

    expect(closeApproval(db, { approvalId: "missing", state: "expired", now: 1_200 })).toBe(false);
  });
});
