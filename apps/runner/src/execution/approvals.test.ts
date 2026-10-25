import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { finishApproval, migrateRunnerDb, pendingApproval } from "@cc-web/runner-db";
import { ApprovalRouter, canonicalInputHash, type ApprovalOutcome } from "./approvals.ts";
import { summarizeToolInput } from "./redact.ts";

/**
 * The runner's approval gate (§13).
 *
 * The properties under test are the ones §13.1 makes non-negotiable:
 *
 *  - every parked callback has a durable row whose identity (`input_hash`,
 *    attempt, expiry) an incoming decision must match exactly
 *  - only `decision === "allow"` is an allow — anything else, including a
 *    corrupted payload, lands on the deny path
 *  - a row leaves `pending` exactly once, so no callback resolves twice and
 *    no late decision can hit a new attempt's callback
 *  - every non-user terminal — timeout, cancel, abort — DENIES the callback
 *    and emits `approval.expired`; nothing implicit ever approves
 */

function setup(): { db: Database } {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  return { db };
}

type Appended = { type: string; payload: Record<string, unknown> };

function harness(now = 1_000) {
  const { db } = setup();
  const events: Appended[] = [];
  const scheduled: Array<{ fn: () => void; ms: number; cancel: () => void }> = [];
  const router = new ApprovalRouter({
    db,
    append: (type, payload) => events.push({ type, payload: payload as Record<string, unknown> }),
    now: () => now,
    schedule: (fn, ms) => {
      const entry = { fn, ms, cancel: () => {} };
      scheduled.push(entry);
      return () => {
        entry.cancel();
      };
    },
  });
  return { db, events, scheduled, router };
}

const TOOL_OPEN = {
  attemptId: "attempt-1",
  runId: "run-1",
  kind: "tool_permission" as const,
  toolName: "Bash",
  input: { command: "ls -la" },
  timeoutMs: 5_000,
};

describe("canonicalInputHash", () => {
  test("is deterministic across key order and sensitive to content", () => {
    const a = canonicalInputHash("Bash", { command: "ls", flags: ["-la"] });
    const sameButDifferentOrder = canonicalInputHash("Bash", { flags: ["-la"], command: "ls" });
    const different = canonicalInputHash("Bash", { command: "rm -rf /" });
    const differentTool = canonicalInputHash("Edit", { command: "ls", flags: ["-la"] });

    expect(a).toBe(sameButDifferentOrder);
    expect(a).not.toBe(different);
    expect(a).not.toBe(differentTool);
  });
});

describe("summarizeToolInput", () => {
  test("redacts credential material and truncates", () => {
    const summary = summarizeToolInput({
      command: "curl -H 'Authorization: Bearer sk-ant-averylongtoken123'",
      filler: "x".repeat(3_000),
    });

    expect(summary).not.toContain("sk-ant-averylongtoken123");
    expect(summary).toContain("[REDACTED]");
    expect(summary.length).toBeLessThanOrEqual(2_000);
  });
});

describe("open", () => {
  test("persists a pending row, schedules the timeout, and appends every identity field", async () => {
    const h = harness();

    const parked = h.router.open(TOOL_OPEN);

    expect(h.events).toHaveLength(1);
    const event = h.events[0]!;
    expect(event.type).toBe("approval.requested");
    expect(event.payload.kind).toBe("tool_permission");
    expect(event.payload.toolName).toBe("Bash");
    expect(event.payload.runId).toBe("run-1");
    expect(event.payload.attemptId).toBe("attempt-1");
    expect(event.payload.callbackGeneration).toBe(0);
    expect(event.payload.inputHash).toBe(canonicalInputHash("Bash", { command: "ls -la" }));
    expect(event.payload.expiresAt).toBe(6_000);
    expect(String(event.payload.approvalId)).toMatch(/^apr_/);
    expect(String(event.payload.toolCallId)).toMatch(/^tc_/);
    expect(event.payload.inputSummary).toContain("ls -la");

    const row = pendingApproval(h.db, String(event.payload.approvalId))!;
    expect(row?.state).toBe("pending");
    expect(row?.attemptId).toBe("attempt-1");
    expect(row?.inputHash).toBe(String(event.payload.inputHash));

    expect(h.scheduled).toHaveLength(1);
    expect(h.scheduled[0]!.ms).toBe(5_000);

    const outcome = await Promise.race([parked, Promise.resolve("still-parked")]);
    expect(outcome).toBe("still-parked");
  });

  test("carries redacted structured questions for user_question kind", async () => {
    const h = harness();
    const questions = [
      {
        question: "Chạy migration lên production?",
        header: "Deploy",
        options: [
          { label: "Có, chạy ngay", description: "x".repeat(600) },
          { label: "Bỏ qua", description: "Không làm gì" },
        ],
      },
    ];

    void h.router.open({
      ...TOOL_OPEN,
      kind: "user_question",
      toolName: "AskUserQuestion",
      input: { questions },
    });

    const payload = h.events[0]!.payload;
    expect(payload.kind).toBe("user_question");
    const projected = payload.questions as Array<{
      question: string;
      options: Array<{ label: string; description: string }>;
    }>;
    expect(projected[0]!.question).toBe("Chạy migration lên production?");
    expect(projected[0]!.options[0]!.label).toBe("Có, chạy ngay");
    expect(projected[0]!.options[0]!.description).toHaveLength(500);
    expect(projected[0]!.options[1]!.description).toBe("Không làm gì");
    expect(payload.inputSummary).toBeUndefined();
  });
});

describe("respond — allow", () => {
  test("resolves the parked callback with the original input and emits approval.resolved", async () => {
    const h = harness();
    const parked = h.router.open(TOOL_OPEN);
    const approvalId = String(h.events[0]!.payload.approvalId);

    const accepted = h.router.respond(
      { approvalId, decision: "allow", inputHash: String(h.events[0]!.payload.inputHash) },
      { attemptId: "attempt-1", runId: "run-1" },
    );
    expect(accepted).toEqual({ ok: true });

    const outcome = (await parked) as ApprovalOutcome;
    expect(outcome).toEqual({ behavior: "allow", updatedInput: { command: "ls -la" } });

    const resolved = h.events.find((e) => e.type === "approval.resolved")!;
    expect(resolved.payload).toEqual({ approvalId, decision: "allow", source: "user" });
    expect(pendingApproval(h.db, approvalId)?.state).toBe("resolved");
  });

  test("merges the user's answers into updatedInput for a question", async () => {
    const h = harness();
    const parked = h.router.open({
      ...TOOL_OPEN,
      kind: "user_question",
      toolName: "AskUserQuestion",
      input: { questions: [{ question: "Q?", options: [{ label: "A" }, { label: "B" }] }] },
    });
    const approvalId = String(h.events[0]!.payload.approvalId);
    const inputHash = String(h.events[0]!.payload.inputHash);

    expect(
      h.router.respond({ approvalId, decision: "allow", answers: { "Q?": "A" }, inputHash }, {
        attemptId: "attempt-1",
        runId: "run-1",
      }),
    ).toEqual({ ok: true });

    const outcome = (await parked) as ApprovalOutcome;
    expect(outcome.behavior).toBe("allow");
    expect((outcome as { updatedInput: { questions: unknown[]; answers: unknown } }).updatedInput).toEqual({
      questions: [{ question: "Q?", options: [{ label: "A" }, { label: "B" }] }],
      answers: { "Q?": "A" },
    });
  });
});

describe("respond — strict parse and refusals", () => {
  test("a corrupted decision string lands on the deny path", async () => {
    const h = harness();
    const parked = h.router.open(TOOL_OPEN);
    const approvalId = String(h.events[0]!.payload.approvalId);
    const inputHash = String(h.events[0]!.payload.inputHash);

    expect(
      h.router.respond({ approvalId, decision: "true" as unknown as "allow", inputHash }, {
        attemptId: "attempt-1",
        runId: "run-1",
      }),
    ).toEqual({ ok: true });

    const outcome = (await parked) as ApprovalOutcome;
    expect(outcome).toEqual({ behavior: "deny", message: "User denied permission for Bash" });
    expect(h.events.find((e) => e.type === "approval.resolved")!.payload.decision).toBe("deny");
  });

  test("a missing decision field denies", async () => {
    const h = harness();
    const parked = h.router.open(TOOL_OPEN);
    const approvalId = String(h.events[0]!.payload.approvalId);
    const inputHash = String(h.events[0]!.payload.inputHash);

    h.router.respond({ approvalId, inputHash } as Parameters<typeof h.router.respond>[0], {
      attemptId: "attempt-1",
      runId: "run-1",
    });

    const outcome = (await parked) as ApprovalOutcome;
    expect(outcome.behavior).toBe("deny");
  });

  test("a deny resolves with the deny message for each kind", async () => {
    const h = harness();
    const parked = h.router.open(TOOL_OPEN);
    const approvalId = String(h.events[0]!.payload.approvalId);
    const inputHash = String(h.events[0]!.payload.inputHash);

    h.router.respond({ approvalId, decision: "deny", inputHash }, {
      attemptId: "attempt-1",
      runId: "run-1",
    });

    expect((await parked) as ApprovalOutcome).toEqual({
      behavior: "deny",
      message: "User denied permission for Bash",
    });

    const h2 = harness();
    const parkedQuestion = h2.router.open({
      ...TOOL_OPEN,
      kind: "user_question",
      toolName: "AskUserQuestion",
      input: { questions: [{ question: "Q?", options: [] }] },
    });
    const qId = String(h2.events[0]!.payload.approvalId);
    const qHash = String(h2.events[0]!.payload.inputHash);
    h2.router.respond({ approvalId: qId, decision: "deny", inputHash: qHash }, {
      attemptId: "attempt-1",
      runId: "run-1",
    });
    expect((await parkedQuestion) as ApprovalOutcome).toEqual({
      behavior: "deny",
      message: "User did not answer the question",
    });
  });

  test("wrong hash, wrong attempt, unknown id, and double respond refuse without touching the callback", async () => {
    const h = harness();
    const parked = h.router.open(TOOL_OPEN);
    const approvalId = String(h.events[0]!.payload.approvalId);
    const inputHash = String(h.events[0]!.payload.inputHash);

    expect(
      h.router.respond({ approvalId, decision: "allow", inputHash: "wrong" }, {
        attemptId: "attempt-1",
        runId: "run-1",
      }),
    ).toEqual({ ok: false, reason: "hash_mismatch" });
    expect(
      h.router.respond({ approvalId, decision: "allow", inputHash }, {
        attemptId: "attempt-2",
        runId: "run-1",
      }),
    ).toEqual({ ok: false, reason: "attempt_mismatch" });
    expect(
      h.router.respond({ approvalId: "apr_missing", decision: "allow", inputHash }, {
        attemptId: "attempt-1",
        runId: "run-1",
      }),
    ).toEqual({ ok: false, reason: "unknown" });

    expect(h.events.filter((e) => e.type === "approval.resolved")).toHaveLength(0);
    expect(pendingApproval(h.db, approvalId)?.state).toBe("pending");

    expect(
      h.router.respond({ approvalId, decision: "allow", inputHash }, {
        attemptId: "attempt-1",
        runId: "run-1",
      }),
    ).toEqual({ ok: true });
    await parked;
    expect(
      h.router.respond({ approvalId, decision: "allow", inputHash }, {
        attemptId: "attempt-1",
        runId: "run-1",
      }),
    ).toEqual({ ok: false, reason: "already_finished" });
  });

  test("a decision after expiry refuses and leaves the row for the sweep", () => {
    const h = harness(1_000);
    void h.router.open(TOOL_OPEN);
    const approvalId = String(h.events[0]!.payload.approvalId);
    const inputHash = String(h.events[0]!.payload.inputHash);

    const late = new ApprovalRouter({
      db: h.db,
      append: () => {},
      now: () => 9_000,
      schedule: () => () => {},
    });

    expect(
      late.respond({ approvalId, decision: "allow", inputHash }, {
        attemptId: "attempt-1",
        runId: "run-1",
      }),
    ).toEqual({ ok: false, reason: "expired" });
  });
});

describe("timeout", () => {
  test("sweepExpired denies past-expiry callbacks and emits approval.expired", async () => {
    const h = harness(1_000);
    const parked = h.router.open(TOOL_OPEN);
    const approvalId = String(h.events[0]!.payload.approvalId);

    h.router.sweepExpired(7_000);

    expect((await parked) as ApprovalOutcome).toEqual({
      behavior: "deny",
      message: "approval timed out",
    });
    const expired = h.events.find((e) => e.type === "approval.expired")!;
    expect(expired.payload).toEqual({ approvalId, reason: "timeout" });
    expect(pendingApproval(h.db, approvalId)?.state).toBe("expired");
  });

  test("sweepExpired leaves rows still inside their window alone", () => {
    const h = harness(1_000);
    void h.router.open(TOOL_OPEN);

    h.router.sweepExpired(2_000);

    expect(h.events.filter((e) => e.type === "approval.expired")).toHaveLength(0);
  });
});

describe("abandonAttempt", () => {
  test("denies every live callback of the attempt and emits expired with the reason", async () => {
    const h = harness(1_000);
    const parked = h.router.open(TOOL_OPEN);
    const approvalId = String(h.events[0]!.payload.approvalId);

    h.router.abandonAttempt("attempt-1", "aborted");

    expect((await parked) as ApprovalOutcome).toEqual({
      behavior: "deny",
      message: "run interrupted",
    });
    const expired = h.events.find((e) => e.type === "approval.expired")!;
    expect(expired.payload).toEqual({ approvalId, reason: "aborted" });
    expect(pendingApproval(h.db, approvalId)?.state).toBe("expired");
  });

  test("a user cancel reports run cancelled", async () => {
    const h = harness(1_000);
    const parked = h.router.open(TOOL_OPEN);

    h.router.abandonAttempt("attempt-1", "cancelled");

    expect((await parked) as ApprovalOutcome).toEqual({
      behavior: "deny",
      message: "run cancelled",
    });
  });

  test("finishes pending rows even without a live callback", () => {
    const h = harness(1_000);
    void h.router.open(TOOL_OPEN);
    const approvalId = String(h.events[0]!.payload.approvalId);

    // Simulate a lost callback: the row stays pending while the router's map
    // forgets it (a fresh router instance sees only the DB row).
    const other = new ApprovalRouter({
      db: h.db,
      append: (type, payload) => h.events.push({ type, payload: payload as Record<string, unknown> }),
      now: () => 1_000,
      schedule: () => () => {},
    });
    other.abandonAttempt("attempt-1", "crashed");

    expect(pendingApproval(h.db, approvalId)?.state).toBe("expired");
    expect(
      h.events.find((e) => e.type === "approval.expired")!.payload,
    ).toEqual({ approvalId, reason: "crashed" });
  });
});

describe("once-guard under races", () => {
  test("a sweep finishing the row makes a racing respond answer already_finished", async () => {
    const h = harness(1_000);
    const parked = h.router.open(TOOL_OPEN);
    const approvalId = String(h.events[0]!.payload.approvalId);
    const inputHash = String(h.events[0]!.payload.inputHash);

    finishApproval(h.db, { approvalId, state: "expired", now: 7_000 });
    expect(
      h.router.respond({ approvalId, decision: "allow", inputHash }, {
        attemptId: "attempt-1",
        runId: "run-1",
      }),
    ).toEqual({ ok: false, reason: "expired" });

    // The callback must still resolve — the sweep owns its terminal now.
    h.router.sweepExpired(7_000);
    expect((await parked) as ApprovalOutcome).toEqual({
      behavior: "deny",
      message: "approval timed out",
    });
  });
});
