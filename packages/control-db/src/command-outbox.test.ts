import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "@cc-web/control-db";
import { CommandOutbox } from "./command-outbox.ts";

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

  test("pending commands are scoped to one runner", async () => {
    const { outbox: o } = outbox();
    await o.enqueue(command);
    await o.enqueue({ ...command, commandId: "cmd-2", runnerId: "runner-b" });

    // §19.2: a runner must never be handed another runner's command.
    expect(o.pendingFor("runner-a").map((c) => c.commandId)).toEqual(["cmd-1"]);
    expect(o.pendingFor("runner-b").map((c) => c.commandId)).toEqual(["cmd-2"]);
  });
});
