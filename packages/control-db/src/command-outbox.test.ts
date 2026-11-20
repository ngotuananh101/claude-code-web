import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "@cc-web/control-db";
import { CommandOutbox, fingerprintOf, MAX_REQUEUES } from "./command-outbox.ts";

/**
 * The central command outbox (§18.1, §9.3, §12.2).
 *
 * A command is written here *before* it is sent, and its delivery state advances
 * only when the Runner proves receipt. The ordering matters: a command that was
 * sent but never recorded is lost work, while one recorded but never sent is
 * recoverable on the next drain.
 *
 * At-least-once is the contract. The Runner's inbox is what makes a redelivery
 * safe, so this layer is free to re-send anything it cannot prove arrived.
 */

function outbox() {
  const db = new Database(":memory:");
  migrate(db);
  return { db, outbox: new CommandOutbox(db) };
}

const command = {
  commandId: "cmd-1",
  runnerId: "runner-a",
  kind: "run.start" as const,
  payload: { prompt: "hello" },
  issuedAt: "2026-10-23T00:00:00.000Z",
};

describe("command outbox", () => {
  test("a command is durably recorded before it can be sent", async () => {
    const { outbox: o } = outbox();

    await o.enqueue(command);

    // The row exists and is undelivered; nothing has been sent yet.
    expect(o.pendingFor("runner-a")).toEqual([
      expect.objectContaining({
        commandId: "cmd-1",
        runnerId: "runner-a",
        kind: "run.start",
        deliveryState: "pending",
        attemptCount: 0,
      }),
    ]);
  });

  test("the same command id cannot be enqueued with a different payload", async () => {
    const { outbox: o } = outbox();
    await o.enqueue(command);

    // §9.3: the fingerprint is immutable. A second enqueue under the same id with
    // different content is a bug in the caller or an attack, not a retry.
    await expect(o.enqueue({ ...command, payload: { prompt: "different" } })).rejects.toThrow(
      /fingerprint/,
    );
  });

  test("re-enqueueing the identical command is a no-op, not an error", async () => {
    const { outbox: o } = outbox();
    await o.enqueue(command);

    await o.enqueue(command);
    expect(o.pendingFor("runner-a")).toHaveLength(1);
  });

  test("a pending command survives reopening the database", async () => {
    const { db, outbox: o } = outbox();
    await o.enqueue(command);

    // A fresh instance over the same handle: the command is recovered by state,
    // not by anything held in memory.
    const reopened = new CommandOutbox(db);
    expect(reopened.pendingFor("runner-a").map((c) => c.commandId)).toEqual(["cmd-1"]);
  });

  test("recording a send moves the command to sent and counts the attempt", async () => {
    const { outbox: o } = outbox();
    await o.enqueue(command);

    o.markSent("cmd-1");

    expect(o.get("cmd-1")).toMatchObject({ deliveryState: "sent", attemptCount: 1 });
  });

  test("a command is re-sent after a reconnect, because delivery was never proven", async () => {
    const { outbox: o } = outbox();
    await o.enqueue(command);
    o.markSent("cmd-1");

    // Still pending for delivery: `sent` means "handed to a socket", not
    // "the runner has it". §12.2.
    expect(o.pendingFor("runner-a").map((c) => c.commandId)).toEqual(["cmd-1"]);
  });

  test("a receipt retires the command and records who accepted it", async () => {
    const { outbox: o } = outbox();
    await o.enqueue(command);
    o.markSent("cmd-1");

    o.markAccepted("cmd-1", "attempt-1");

    expect(o.get("cmd-1")).toMatchObject({
      deliveryState: "accepted",
      attemptId: "attempt-1",
    });
    expect(o.pendingFor("runner-a")).toEqual([]);
  });

  test("a receipt for an unknown command is refused rather than silently recorded", async () => {
    const { outbox: o } = outbox();

    // Accepting it would let a malformed receipt create a row that nothing
    // enqueued, which then looks like delivered work.
    expect(() => o.markAccepted("cmd-unknown", "attempt-1")).toThrow(/unknown command/);
  });

  test("an answered command with no receipt is retired without inventing an attempt", async () => {
    const { outbox: o } = outbox();
    // §23 Ruling 2: an inspection's answer IS its `rpc.result` — no receipt, and
    // no attempt for a receipt to name. Retiring it must not fabricate one.
    await o.enqueue({
      ...command,
      kind: "workspace.inspect",
      payload: { op: "git.changes" },
    });
    o.markSent("cmd-1");

    o.markAnswered("cmd-1");

    expect(o.get("cmd-1")).toMatchObject({
      deliveryState: "accepted",
      attemptId: undefined,
    });
    expect(o.pendingFor("runner-a")).toEqual([]);
  });

  test("a rejected command is retired with its reason and is not re-sent", async () => {
    const { outbox: o } = outbox();
    await o.enqueue(command);
    o.markSent("cmd-1");

    o.markRejected("cmd-1", "runner_unavailable");

    expect(o.get("cmd-1")).toMatchObject({
      deliveryState: "rejected",
      rejectionReason: "runner_unavailable",
    });
    expect(o.pendingFor("runner-a")).toEqual([]);
  });

  test("a late receipt after rejection does not resurrect the command", async () => {
    const { outbox: o } = outbox();
    await o.enqueue(command);
    o.markSent("cmd-1");
    o.markRejected("cmd-1", "expired");

    o.markAccepted("cmd-1", "attempt-1");

    // Terminal delivery states are sticky. Reopening one would double-execute
    // whatever the rejection already told the rest of the system.
    expect(o.get("cmd-1")?.deliveryState).toBe("rejected");
  });

  test("an expired command is retired before it is ever sent", async () => {
    const { outbox: o } = outbox();
    await o.enqueue({ ...command, expiresAt: "2026-10-23T00:00:00.000Z" });

    // Expiry is evaluated at drain time against the current clock, not at
    // enqueue time, so a stale row cannot sit pending forever.
    expect(o.pendingFor("runner-a", { now: new Date("2026-10-23T01:00:00.000Z") })).toEqual([]);
  });

  test("an expired command is retired, not left pending forever", async () => {
    const { outbox: o } = outbox();
    await o.enqueue({ ...command, expiresAt: "2026-10-23T00:00:00.000Z" });

    const retired = o.retireExpired("runner-a", new Date("2026-10-23T01:00:00.000Z"));

    // Filtering it out of the drain is not enough: the row would stay `pending`
    // for the life of the database, and an operator watching outbox age would
    // see work that is never going to move.
    expect(retired).toEqual(["cmd-1"]);
    expect(o.get("cmd-1")).toMatchObject({
      deliveryState: "rejected",
      rejectionReason: "expired",
    });
  });

  test("retiring expired commands leaves the ones that are still valid", async () => {
    const { outbox: o } = outbox();
    await o.enqueue({ ...command, expiresAt: "2026-10-23T00:00:00.000Z" });
    await o.enqueue({ ...command, commandId: "cmd-2", expiresAt: "2026-10-24T00:00:00.000Z" });
    await o.enqueue({ ...command, commandId: "cmd-3" });

    const retired = o.retireExpired("runner-a", new Date("2026-10-23T01:00:00.000Z"));

    expect(retired).toEqual(["cmd-1"]);
    expect(o.pendingFor("runner-a", { now: new Date("2026-10-23T01:00:00.000Z") })).toHaveLength(2);
  });

  test("pending commands are scoped to one runner", async () => {
    const { outbox: o } = outbox();
    await o.enqueue(command);
    await o.enqueue({ ...command, commandId: "cmd-2", runnerId: "runner-b" });

    // §19.2: a runner must never be handed another runner's command.
    expect(o.pendingFor("runner-a").map((c) => c.commandId)).toEqual(["cmd-1"]);
    expect(o.pendingFor("runner-b").map((c) => c.commandId)).toEqual(["cmd-2"]);
  });

  test("the envelope fields survive the round trip, so a drain can rebuild the frame", async () => {
    const { outbox: o } = outbox();

    await o.enqueue({
      ...command,
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      workspaceId: "workspace-1",
    });

    // §9.1 puts these at the top level of the envelope, not inside the payload.
    // The dispatcher rebuilds the frame from this row alone; if a field is lost
    // here it has to guess, and the runner would receive a command it cannot
    // attribute to a session.
    expect(o.get("cmd-1")).toMatchObject({
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      workspaceId: "workspace-1",
    });
  });

  test("the stored fingerprint does not change when only envelope fields are re-sent", async () => {
    const { outbox: o } = outbox();
    await o.enqueue({ ...command, sessionId: "session-1", runId: "run-1" });

    // Same command id, same meaning: a retry by the caller. Session and run are
    // routing metadata, and including them would make an identical retry look
    // like a different command.
    await expect(
      o.enqueue({ ...command, sessionId: "session-1", runId: "run-1" }),
    ).resolves.toBeUndefined();
  });

  test("a receipt for the attempt the command was issued for is recorded", async () => {
    const { outbox: o } = outbox();
    await o.enqueue({ ...command, attemptId: "attempt-1" });

    o.markAccepted("cmd-1", "attempt-1");

    expect(o.get("cmd-1")).toMatchObject({ deliveryState: "accepted", attemptId: "attempt-1" });
  });

  test("a receipt naming a different attempt does not overwrite the issued one", async () => {
    const { outbox: o } = outbox();
    await o.enqueue({ ...command, attemptId: "attempt-1" });

    // The runner claiming a receipt for an attempt the server never issued is
    // evidence of a conflict, not a correction to apply. Overwriting here would
    // rewrite which attempt the command belonged to, after the fact.
    o.markAccepted("cmd-1", "attempt-other");

    expect(o.get("cmd-1")).toMatchObject({ deliveryState: "accepted", attemptId: "attempt-1" });
  });

  test("a workspace.revert row round-trips through the outbox", async () => {
    const { db, outbox: o } = outbox();

    await o.enqueue({
      commandId: "c-revert",
      runnerId: "r-1",
      kind: "workspace.revert",
      payload: { op: "workspace.revert", planDigest: "d1" },
      issuedAt: new Date(0).toISOString(),
      workspaceId: "default",
    });

    // The kind is stored verbatim and the payload survives JSON round-trip, so
    // the dispatcher can rebuild the workspace.revert frame verbatim from the row.
    const row = db
      .query("SELECT kind, payload FROM command_outbox WHERE command_id = ?")
      .get("c-revert") as { kind: string; payload: string };
    expect(row.kind).toBe("workspace.revert");
    expect(JSON.parse(row.payload)).toEqual({ op: "workspace.revert", planDigest: "d1" });
  });

  test("requeue writes a durable retry deadline, capped, and maps retryAfter (boundary)", async () => {
    const { db, outbox: o } = outbox();
    await o.enqueue({ ...command, workspaceId: "workspace-1" });
    o.markRejected("cmd-1", "workspace_busy");

    const now = 1_000_000;
    expect(o.requeue("cmd-1", { now })).toBe("requeued");
    const row1 = o.get("cmd-1");
    expect(row1).toMatchObject({
      deliveryState: "queued",
      requeueCount: 1,
      retryAfter: now + 1000,
    });

    // previousCount 1 -> 2000, 2 -> 4000, 3 -> 8000, 4 -> 16000, 5 -> 30000 (cap), 6 -> 30000
    const expectations: Array<[number, number]> = [
      [2, 2000],
      [3, 4000],
      [4, 8000],
      [5, 16000],
      [6, 30000],
      [7, 30000],
    ];
    for (const [count, delay] of expectations) {
      db.query(
        "UPDATE command_outbox SET delivery_state = 'rejected', rejection_reason = 'workspace_busy' WHERE command_id = 'cmd-1'",
      ).run();
      const t = now + count * 10;
      expect(o.requeue("cmd-1", { now: t })).toBe("requeued");
      expect(o.get("cmd-1")).toMatchObject({ requeueCount: count, retryAfter: t + delay });
    }

    // ceiling preserved: > MAX_REQUEUES refuses
    db.query(
      "UPDATE command_outbox SET delivery_state = 'rejected', requeue_count = ? WHERE command_id = 'cmd-1'",
    ).run(MAX_REQUEUES + 1);
    expect(o.requeue("cmd-1", { now })).toBe("ceiling");
    expect(o.get("cmd-1")).toMatchObject({
      deliveryState: "rejected",
      requeueCount: MAX_REQUEUES + 1,
    });
  });

  test("legacy schema defaults leave retry_after null and markPromoted clears the deadline", async () => {
    const { db, outbox: o } = outbox();
    await o.enqueue({ ...command, workspaceId: "workspace-1" });
    // legacy/default: no retry deadline
    expect(o.get("cmd-1")?.retryAfter).toBeUndefined();
    expect(
      (
        db.query("SELECT retry_after FROM command_outbox WHERE command_id = 'cmd-1'").get() as {
          retry_after: number | null;
        }
      ).retry_after,
    ).toBeNull();

    o.markRejected("cmd-1", "workspace_busy");
    o.requeue("cmd-1", { now: 5000 });
    expect(o.get("cmd-1")?.retryAfter).toBe(6000);

    o.markPromoted("cmd-1");
    expect(o.get("cmd-1")).toMatchObject({ deliveryState: "pending", retryAfter: undefined });
    expect(
      (
        db.query("SELECT retry_after FROM command_outbox WHERE command_id = 'cmd-1'").get() as {
          retry_after: number | null;
        }
      ).retry_after,
    ).toBeNull();
  });

  test("workspaceRetryAfter returns MAX retry_after for queued run.start rows, resolving snapshot then column", async () => {
    const { db, outbox: o } = outbox();
    const base = 10_000;
    // matching workspace, different deadlines
    await o.enqueue({
      ...command,
      commandId: "c1",
      runId: "r1",
      workspaceId: "ws-a",
      deliveryState: "queued",
      queueSnapshot: { runnerId: "runner-a", workspaceId: "ws-a" },
    });
    await o.enqueue({
      ...command,
      commandId: "c2",
      runId: "r2",
      workspaceId: "ws-a",
      deliveryState: "queued",
      queueSnapshot: { runnerId: "runner-a", workspaceId: "ws-a" },
    });
    await o.enqueue({
      ...command,
      commandId: "c3",
      runId: "r3",
      workspaceId: "ws-b",
      deliveryState: "queued",
      queueSnapshot: { runnerId: "runner-a", workspaceId: "ws-b" },
    });
    // divergent snapshot/column: resolved workspace follows snapshot (ws-a)
    await o.enqueue({
      ...command,
      commandId: "c4",
      runId: "r4",
      workspaceId: "ws-b",
      deliveryState: "queued",
      queueSnapshot: { runnerId: "runner-a", workspaceId: "ws-a" },
    });
    // plain queued row (no retry_after) must not impose a cooldown
    await o.enqueue({
      ...command,
      commandId: "c5",
      runId: "r5",
      workspaceId: "ws-a",
      deliveryState: "queued",
      queueSnapshot: { runnerId: "runner-a", workspaceId: "ws-a" },
    });
    await o.enqueue({
      ...command,
      commandId: "c6",
      runId: "r6",
      workspaceId: "ws-a",
      deliveryState: "queued",
    });
    // An older/malformed snapshot with null workspace falls back to workspace_id.
    db.query("UPDATE command_outbox SET queue_snapshot = ? WHERE command_id = 'c6'").run(
      JSON.stringify({ runnerId: "runner-a", workspaceId: null }),
    );

    db.query("UPDATE command_outbox SET retry_after = ? WHERE command_id = 'c1'").run(base + 100);
    db.query("UPDATE command_outbox SET retry_after = ? WHERE command_id = 'c2'").run(base + 500);
    db.query("UPDATE command_outbox SET retry_after = ? WHERE command_id = 'c3'").run(base + 9000);
    db.query("UPDATE command_outbox SET retry_after = ? WHERE command_id = 'c4'").run(base + 300);
    db.query("UPDATE command_outbox SET retry_after = ? WHERE command_id = 'c6'").run(base + 700);

    expect(o.workspaceRetryAfter("runner-a", "ws-a")).toBe(base + 700);
    expect(o.workspaceRetryAfter("runner-a", "ws-b")).toBe(base + 9000);
    expect(o.workspaceRetryAfter("runner-a", "ws-missing")).toBeUndefined();
    expect(o.workspaceRetryAfter("runner-b", "ws-a")).toBeUndefined();
  });

  test("runnersWithQueuedStarts returns every runner with any queued run.start, deterministically", async () => {
    const { db, outbox: o } = outbox();
    const mk = async (id: string, runnerId: string, state: "queued" | "pending" = "queued") => {
      await o.enqueue({
        ...command,
        commandId: id,
        runnerId,
        runId: `run-${id}`,
        workspaceId: "ws",
        deliveryState: state,
        queueSnapshot: { runnerId, workspaceId: "ws" },
      });
    };
    await mk("a-due", "runner-b");
    await mk("b-plain", "runner-a"); // null retry_after (ordinary queued sibling)
    await mk("c-future", "runner-c");
    await mk("d-dup", "runner-a"); // same runner, must be distinct
    await mk("e-nonstart", "runner-e");
    db.query("UPDATE command_outbox SET kind = 'run.cancel' WHERE command_id = 'e-nonstart'").run();
    await mk("f-terminal", "runner-f");
    db.query(
      "UPDATE command_outbox SET delivery_state = 'rejected', rejected_at = 1 WHERE command_id = 'f-terminal'",
    ).run();
    await mk("g-pending", "runner-g", "pending");

    db.query("UPDATE command_outbox SET retry_after = ? WHERE command_id = 'a-due'").run(100);
    db.query("UPDATE command_outbox SET retry_after = ? WHERE command_id = 'c-future'").run(200);

    // ALL queued run.start runners, including plain and future-deadline rows; no
    // terminal, non-start, or non-queued rows. Deterministic by runner_id.
    expect(o.runnersWithQueuedStarts()).toEqual(["runner-a", "runner-b", "runner-c"]);
  });

  test("a command with a secure payload stores it separately from the redacted payload", async () => {
    const { db, outbox: o } = outbox();

    await o.enqueue({
      ...command,
      payload: { profile: { apiKey: "[REDACTED]" } },
      payloadSecure: { profile: { apiKey: "sk-secret" } },
    });

    const row = db
      .query("SELECT payload, payload_secure FROM command_outbox WHERE command_id = ?")
      .get("cmd-1") as { payload: string; payload_secure: string | null };

    // The persisted payload is redacted; the secure column holds the cleartext.
    expect(JSON.parse(row.payload)).toEqual({ profile: { apiKey: "[REDACTED]" } });
    expect(JSON.parse(row.payload_secure!)).toEqual({ profile: { apiKey: "sk-secret" } });

    // pendingFor returns the cleartext in payloadSecure so the dispatcher can
    // use it for the live frame.
    const pending = o.pendingFor("runner-a");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload).toEqual({ profile: { apiKey: "[REDACTED]" } });
    expect(pending[0]?.payloadSecure).toEqual({ profile: { apiKey: "sk-secret" } });
  });

  test("a command without a secure payload has a null payload_secure column", async () => {
    const { db, outbox: o } = outbox();

    await o.enqueue(command);

    const row = db
      .query("SELECT payload_secure FROM command_outbox WHERE command_id = ?")
      .get("cmd-1") as { payload_secure: string | null };

    expect(row.payload_secure).toBeNull();
    expect(o.get("cmd-1")?.payloadSecure).toBeUndefined();
  });

  test("a queued command is never offered for delivery", async () => {
    const { outbox: o } = outbox();
    await o.enqueue({
      ...command,
      deliveryState: "queued",
      queueSnapshot: { runnerId: "runner-a", workspaceId: "workspace-1" },
    });

    expect(o.pendingFor("runner-a")).toEqual([]);
    expect(o.queuedFor("runner-a")).toMatchObject([
      {
        commandId: "cmd-1",
        deliveryState: "queued",
        queueSnapshot: { runnerId: "runner-a", workspaceId: "workspace-1" },
        requeueCount: 0,
      },
    ]);
  });

  test("a queued command is retired when it expires, like any other", async () => {
    const { outbox: o } = outbox();
    await o.enqueue({
      ...command,
      deliveryState: "queued",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });

    expect(o.pendingFor("runner-a")).toEqual([]);
    expect(o.retireExpired("runner-a")).toEqual(["cmd-1"]);
    expect(o.get("cmd-1")).toMatchObject({ deliveryState: "rejected", rejectionReason: "expired" });
  });

  test("requeue returns a rejected run.start to the queue and counts the attempt", async () => {
    const { outbox: o } = outbox();
    await o.enqueue({ ...command, workspaceId: "workspace-1" });
    o.markRejected("cmd-1", "workspace_busy");

    expect(o.requeue("cmd-1")).toBe("requeued");
    expect(o.get("cmd-1")).toMatchObject({
      deliveryState: "queued",
      requeueCount: 1,
      rejectionReason: undefined,
      queueSnapshot: { runnerId: "runner-a", workspaceId: "workspace-1" },
    });
  });

  test("requeue only moves a rejected command", async () => {
    const { outbox: o } = outbox();
    await o.enqueue(command); // pending
    expect(o.requeue("cmd-1")).toBe("not_rejected");
    expect(o.get("cmd-1")).toMatchObject({ deliveryState: "pending", requeueCount: 0 });
  });

  test("requeue refuses past the ceiling and leaves the row rejected", async () => {
    const { db, outbox: o } = outbox();
    await o.enqueue(command);
    o.markRejected("cmd-1", "workspace_busy");
    // The spec's ceiling test is `requeue_count > 50`, so 51 is the first refusal.
    db.query("UPDATE command_outbox SET requeue_count = ? WHERE command_id = 'cmd-1'").run(
      MAX_REQUEUES + 1,
    );

    expect(o.requeue("cmd-1")).toBe("ceiling");
    expect(o.get("cmd-1")).toMatchObject({
      deliveryState: "rejected",
      requeueCount: MAX_REQUEUES + 1,
    });
  });

  test("promotion flips a queued command to deliverable", async () => {
    const { outbox: o } = outbox();
    await o.enqueue({ ...command, deliveryState: "queued" });
    o.markPromoted("cmd-1");

    expect(o.get("cmd-1")).toMatchObject({ deliveryState: "pending", queueSnapshot: undefined });
    expect(o.pendingFor("runner-a").map((c) => c.commandId)).toEqual(["cmd-1"]);
  });

  test("queuedForSession lists one session's queue oldest first", async () => {
    const { db, outbox: o } = outbox();
    await o.enqueue({ ...command, sessionId: "session-1", deliveryState: "queued" }); // created_at earlier
    await o.enqueue({
      ...command,
      commandId: "cmd-2",
      runId: "run-2",
      sessionId: "session-2",
      deliveryState: "queued",
    });
    await o.enqueue({
      ...command,
      commandId: "cmd-3",
      runId: "run-3",
      sessionId: "session-1",
      deliveryState: "queued",
    });
    await o.enqueue({ ...command, commandId: "cmd-4", runId: "run-4", sessionId: "session-1" }); // accepted later

    // created_at is a millisecond clock; force a deterministic order instead of racing it.
    db.query("UPDATE command_outbox SET created_at = 1 WHERE command_id = 'cmd-1'").run();
    db.query("UPDATE command_outbox SET created_at = 3 WHERE command_id = 'cmd-3'").run();

    expect(o.queuedForSession("session-1").map((c) => c.commandId)).toEqual(["cmd-1", "cmd-3"]);
  });

  /**
   * §"Resume semantics": a run that becomes queued must not keep the
   * `resumeSessionId` its payload was built with at submit time — by the time
   * it starts, the preceding run in that session may have produced a newer
   * conversation id, and resuming the frozen one would resume a stale
   * transcript.
   *
   * `requeue` is the second path into `queued` (the first is a dispatch that
   * queues immediately, and the third is losing the active_runs race). A
   * transient rejection takes a command that was **admitted** — so its payload
   * does carry the field — and returns it to the queue, which is exactly the
   * case that has to strip it.
   */
  test("requeue strips a frozen resumeSessionId and rewrites the fingerprint with it", async () => {
    const { db, outbox: o } = outbox();
    const resumeCommand = {
      ...command,
      payload: { prompt: "hello", resumeSessionId: "sdk-conversation-1" },
      workspaceId: "workspace-1",
    };
    await o.enqueue(resumeCommand);
    o.markRejected("cmd-1", "workspace_busy");

    expect(o.requeue("cmd-1")).toBe("requeued");
    const row = o.get("cmd-1");
    expect(row?.deliveryState).toBe("queued");

    // Absent, not merely falsy: an empty string would be the same bug.
    const payload = (row as { payload: Record<string, unknown> }).payload;
    expect("resumeSessionId" in payload).toBe(false);
    // And nothing else in the payload moved.
    expect(row?.payload).toEqual({ prompt: "hello" });

    // The fingerprint describes the payload the runner will actually receive.
    // A stale one makes the redelivery a `fingerprint_mismatch`, i.e. a
    // command that can never be delivered again.
    const stored = (
      db.query("SELECT fingerprint FROM command_outbox WHERE command_id = 'cmd-1'").get() as {
        fingerprint: string;
      }
    ).fingerprint;
    expect(stored).toBe(
      await fingerprintOf({
        commandId: "cmd-1",
        runnerId: "runner-a",
        kind: "run.start",
        payload: { prompt: "hello" },
        issuedAt: command.issuedAt,
      }),
    );
  });

  test("requeue leaves a payload that never had resumeSessionId byte-for-byte alone", async () => {
    const { db, outbox: o } = outbox();
    await o.enqueue({ ...command, workspaceId: "workspace-1" });
    const before = db
      .query("SELECT payload, fingerprint FROM command_outbox WHERE command_id = 'cmd-1'")
      .get() as { payload: string; fingerprint: string };
    o.markRejected("cmd-1", "draining");

    expect(o.requeue("cmd-1")).toBe("requeued");

    const after = db
      .query("SELECT payload, fingerprint FROM command_outbox WHERE command_id = 'cmd-1'")
      .get() as { payload: string; fingerprint: string };
    // Rewriting an unrelated row's fingerprint would be silent corruption of
    // the outbox's immutability contract.
    expect(after).toEqual(before);
  });

  /**
   * The path a profile run actually takes (§18.1): the runner receives
   * `payload_secure` (opened) when one exists, and the redacted `payload`
   * otherwise. Stripping only the redacted copy would leave the field the
   * runner really executes, so both columns have to move together.
   */
  test("requeue strips resumeSessionId from the secure payload too, and hashes the redacted copy", async () => {
    const { db, outbox: o } = outbox();
    await o.enqueue({
      ...command,
      payload: {
        prompt: "hello",
        resumeSessionId: "sdk-conversation-1",
        profile: { apiKey: "[REDACTED]" },
      },
      payloadSecure: {
        prompt: "hello",
        resumeSessionId: "sdk-conversation-1",
        profile: { apiKey: "sk-secret" },
      },
    });
    o.markRejected("cmd-1", "workspace_busy");

    expect(o.requeue("cmd-1")).toBe("requeued");

    const row = db
      .query("SELECT payload, payload_secure, fingerprint FROM command_outbox WHERE command_id = ?")
      .get("cmd-1") as { payload: string; payload_secure: string; fingerprint: string };
    expect(JSON.parse(row.payload)).toEqual({ prompt: "hello", profile: { apiKey: "[REDACTED]" } });
    expect(JSON.parse(row.payload_secure)).toEqual({
      prompt: "hello",
      profile: { apiKey: "sk-secret" },
    });
    // The digest describes the redacted copy, which is what `fingerprintOf`
    // hashes — not the clear one, whose key changes between dispatches.
    expect(row.fingerprint).toBe(
      await fingerprintOf({
        commandId: "cmd-1",
        runnerId: "runner-a",
        kind: "run.start",
        payload: { prompt: "hello", profile: { apiKey: "[REDACTED]" } },
        issuedAt: command.issuedAt,
      }),
    );
  });
});
