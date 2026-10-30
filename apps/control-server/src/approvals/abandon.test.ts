import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { approvalForSession, migrate, upsertApprovalRequested } from "@cc-web/control-db";
import type { BrowserReplayEvent } from "@cc-web/protocol";
import { abandonAttemptApprovals } from "./abandon.ts";

/**
 * Announcing reconciliation's abandon (§13.1, §14.3).
 *
 * Closing the projection is not enough: a browser card is read-only only when
 * a terminal event for its approval id is in the journal (§13.2). With the
 * runner's gate gone, this module is the only place that event can come from.
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
  expiresAt: Number.MAX_SAFE_INTEGER,
};

describe("abandonAttemptApprovals", () => {
  test("closes the attempt's pending approval and journals approval.expired", () => {
    const db = setup();
    upsertApprovalRequested(db, { ...requested, now: 900 });
    const published: Array<{ sessionId: string } & BrowserReplayEvent> = [];

    const closed = abandonAttemptApprovals({
      db,
      attemptId: "attempt-1",
      publish: (event) => published.push(event),
      now: 1_000,
    });

    expect(closed.map((row) => row.approvalId)).toEqual(["apr-1"]);
    expect(approvalForSession(db, "apr-1")?.state).toBe("expired");

    const rows = db
      .prepare("SELECT type, payload FROM run_events ORDER BY session_sequence")
      .all() as Array<{ type: string; payload: string }>;
    expect(rows).toEqual([
      {
        type: "approval.expired",
        payload: JSON.stringify({ approvalId: "apr-1", reason: "abandoned" }),
      },
    ]);

    // The same event reached the live browser fan-out, so the card closes
    // without a reload.
    expect(published).toHaveLength(1);
    expect(published[0]?.sessionId).toBe("session-1");
    expect(published[0]?.type).toBe("approval.expired");
    expect(published[0]?.payload).toEqual({ approvalId: "apr-1", reason: "abandoned" });
    expect(published[0]?.sessionSequence).toBe(1);
  });

  test("leaves a decided approval alone and journals nothing for it", () => {
    const db = setup();
    upsertApprovalRequested(db, { ...requested, now: 900 });
    db.prepare("UPDATE approvals SET state = 'decided' WHERE approval_id = 'apr-1'").run();
    const published: unknown[] = [];

    const closed = abandonAttemptApprovals({
      db,
      attemptId: "attempt-1",
      publish: (event) => published.push(event),
    });

    expect(closed).toEqual([]);
    expect(published).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM run_events").get()).toEqual({ n: 0 });
  });
});
