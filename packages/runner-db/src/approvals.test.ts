import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { finishApproval, insertPendingApproval, pendingApproval } from "./approvals.ts";
import { migrateRunnerDb } from "./db.ts";

/**
 * Runner-local pending approvals (§13).
 *
 * The row is the gate's memory: it carries the identity (`input_hash`,
 * `callback_generation`) an incoming decision must match before a parked SDK
 * callback may resolve, and its `state` CAS is the once-guard that keeps a
 * replayed command from resolving a callback twice.
 */

function freshDb(): Database {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  return db;
}

const pending = {
  approvalId: "apr-1",
  attemptId: "attempt-1",
  toolCallId: "tc-1",
  inputHash: "hash-1",
  callbackGeneration: 0,
  kind: "tool_permission" as const,
  expiresAt: 5_000,
  now: 1_000,
};

describe("insertPendingApproval", () => {
  test("inserts a pending row that reads back with its identity", () => {
    const db = freshDb();

    expect(insertPendingApproval(db, pending)).toEqual({ ok: true });

    expect(pendingApproval(db, "apr-1")).toEqual({
      approvalId: "apr-1",
      attemptId: "attempt-1",
      toolCallId: "tc-1",
      inputHash: "hash-1",
      callbackGeneration: 0,
      kind: "tool_permission",
      expiresAt: 5_000,
      state: "pending",
    });
  });

  test("answers duplicate for the same approval id", () => {
    const db = freshDb();
    insertPendingApproval(db, pending);

    const again = insertPendingApproval(db, { ...pending, expiresAt: 9_999 });

    expect(again).toEqual({ ok: false, reason: "duplicate" });
    expect(pendingApproval(db, "apr-1")?.expiresAt).toBe(5_000);
  });
});

describe("finishApproval", () => {
  test("claims a pending row exactly once", () => {
    const db = freshDb();
    insertPendingApproval(db, pending);

    expect(finishApproval(db, { approvalId: "apr-1", state: "resolved", now: 2_000 })).toBe(true);
    expect(finishApproval(db, { approvalId: "apr-1", state: "expired", now: 2_100 })).toBe(false);

    const row = pendingApproval(db, "apr-1");
    expect(row?.state).toBe("resolved");
  });

  test("expires a pending row", () => {
    const db = freshDb();
    insertPendingApproval(db, pending);

    expect(finishApproval(db, { approvalId: "apr-1", state: "expired", now: 6_000 })).toBe(true);
    expect(pendingApproval(db, "apr-1")?.state).toBe("expired");
  });
});

describe("pendingApproval", () => {
  test("answers undefined for an unknown approval", () => {
    const db = freshDb();

    expect(pendingApproval(db, "missing")).toBeUndefined();
  });
});

describe("state lifecycle", () => {
  test("state never leaves {pending, resolved, expired}", () => {
    const db = freshDb();
    insertPendingApproval(db, pending);
    expect(pendingApproval(db, "apr-1")?.state).toBe("pending");

    finishApproval(db, { approvalId: "apr-1", state: "resolved", now: 2_000 });
    const resolved = db
      .prepare("SELECT DISTINCT state FROM pending_approvals")
      .all() as Array<{ state: string }>;
    expect(resolved.every((r) => ["pending", "resolved", "expired"].includes(r.state))).toBe(true);
  });
});
