import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { acceptCommand, migrateRunnerDb } from "@cc-web/runner-db";
import { handleCommand } from "./command-handler.ts";

/**
 * Receiving a command on the runner (§9.3).
 *
 * The receipt is the whole point, and its timing is the interesting part: it is
 * sent **after** the inbox transaction commits, never before. A receipt sent
 * first would tell the server "I have it" for a command a crash could still
 * erase, and the server would stop redelivering it.
 *
 * The other rule is that a duplicate is answered from the stored receipt rather
 * than executed twice — the transport is at-least-once, so duplicates are
 * normal, not exceptional.
 */

function setup() {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  return { db };
}

const command = {
  protocolVersion: 1,
  commandId: "cmd-1",
  runnerId: "runner-a",
  kind: "run.start",
  issuedAt: "2026-10-23T00:00:00.000Z",
  payload: { prompt: "hello" },
  sessionId: "session-1",
  runId: "run-1",
  attemptId: "attempt-1",
  workspaceId: "workspace-1",
};

describe("handling an incoming command", () => {
  test("a new command is persisted and acknowledged", () => {
    const { db } = setup();

    const result = handleCommand(db, command, { localRunnerId: "runner-a" });

    expect(result).toEqual({
      receipt: { commandId: "cmd-1", attemptId: "attempt-1", accepted: true },
      execute: true,
    });
    expect(db.prepare("SELECT state FROM command_inbox WHERE command_id = ?").get("cmd-1")).toEqual(
      { state: "accepted" },
    );
  });

  test("a redelivered command is acknowledged from the stored receipt, not re-executed", () => {
    const { db } = setup();
    handleCommand(db, command, { localRunnerId: "runner-a" });

    const again = handleCommand(db, command, { localRunnerId: "runner-a" });

    // At-least-once means this happens routinely after a lost ACK. Running the
    // SDK again here is exactly the double execution the inbox exists to stop.
    expect(again).toMatchObject({
      receipt: { commandId: "cmd-1", accepted: true },
      execute: false,
    });
  });

  test("a command for another runner is refused with a reason", () => {
    const { db } = setup();

    const result = handleCommand(
      db,
      { ...command, runnerId: "runner-b" },
      {
        localRunnerId: "runner-a",
      },
    );

    expect(result.receipt).toMatchObject({
      commandId: "cmd-1",
      accepted: false,
      reason: "wrong_runner",
    });
    expect(result.execute).toBe(false);
  });

  test("an expired command is refused and never executed", () => {
    const { db } = setup();

    // §9.5: a start that sat in a queue for hours must not launch just because
    // it is still in the inbox.
    const result = handleCommand(
      db,
      { ...command, expiresAt: "2026-10-23T00:00:00.000Z" },
      { localRunnerId: "runner-a", now: Date.parse("2026-10-23T01:00:00.000Z") },
    );

    expect(result.receipt).toMatchObject({ accepted: false, reason: "expired" });
    expect(result.execute).toBe(false);
  });

  test("the same id with different content is refused and audited", () => {
    const { db } = setup();
    handleCommand(db, command, { localRunnerId: "runner-a" });

    const result = handleCommand(
      db,
      { ...command, payload: { prompt: "something else" } },
      { localRunnerId: "runner-a" },
    );

    expect(result.receipt).toMatchObject({ accepted: false, reason: "fingerprint_mismatch" });
    // The audit row is what makes a conflict investigable later; without it the
    // rejection looks like a plain duplicate.
    expect(
      db.prepare("SELECT reason FROM inbox_rejections WHERE command_id = ?").all("cmd-1"),
    ).toEqual([{ reason: "fingerprint_mismatch" }]);
  });

  test("a malformed envelope is refused without touching the inbox", () => {
    const { db } = setup();

    const result = handleCommand(db, { commandId: "cmd-1" }, { localRunnerId: "runner-a" });

    expect(result.receipt).toMatchObject({ commandId: "cmd-1", accepted: false });
    expect(result.execute).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM command_inbox").get()).toEqual({ n: 0 });
  });
});

describe("the inbox and the handler agree", () => {
  test("a command the handler accepted is the one the inbox holds", () => {
    const { db } = setup();
    const result = handleCommand(db, command, { localRunnerId: "runner-a" });

    // Cross-check against the repository directly: if these two disagree, the
    // receipt is describing a state the database does not have.
    expect(result.execute).toBe(true);
    expect(acceptCommand(db, command as never, { localRunnerId: "runner-a" })).toMatchObject({
      ok: true,
      duplicate: true,
    });
  });
});
