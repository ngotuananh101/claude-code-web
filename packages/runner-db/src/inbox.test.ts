import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrateRunnerDb } from "./db.ts";
import { acceptCommand, type CommandEnvelope } from "./inbox.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  return db;
}

function command(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    protocolVersion: 1,
    commandId: "cmd-1",
    runnerId: "runner-a",
    kind: "run.start",
    issuedAt: "2026-10-23T00:00:00.000Z",
    payload: { prompt: "hi" },
    ...overrides,
  };
}

describe("runner inbox", () => {
  test("accepts a new command exactly once", () => {
    const db = freshDb();
    const result = acceptCommand(db, command(), { now: 1_000 });
    expect(result).toEqual({ ok: true, duplicate: false, state: "accepted" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM command_inbox").get()).toEqual({ n: 1 });
  });

  test("re-delivery of the same command returns the stored receipt, not a second row", () => {
    const db = freshDb();
    const first = acceptCommand(db, command(), { now: 1_000 });
    const second = acceptCommand(db, command(), { now: 2_000 });

    expect(first).toEqual({ ok: true, duplicate: false, state: "accepted" });
    // §9.3: a duplicate must not spawn the SDK twice. The receipt is the answer.
    expect(second).toEqual({ ok: true, duplicate: true, state: "accepted" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM command_inbox").get()).toEqual({ n: 1 });
  });

  test("same command id with a different payload is rejected and audited", () => {
    const db = freshDb();
    acceptCommand(db, command(), { now: 1_000 });

    const conflicting = acceptCommand(db, command({ payload: { prompt: "evil" } }), { now: 2_000 });

    // §9.3: "Cùng ID khác payload phải bị reject và audit."
    expect(conflicting).toEqual({ ok: false, reason: "fingerprint_mismatch" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM command_inbox").get()).toEqual({ n: 1 });

    const audit = db.prepare("SELECT reason, command_id FROM inbox_rejections").all();
    expect(audit).toEqual([{ reason: "fingerprint_mismatch", command_id: "cmd-1" }]);
  });

  test("fingerprint is stable regardless of payload key order", () => {
    const db = freshDb();
    acceptCommand(db, command({ payload: { a: 1, b: 2 } }), { now: 1_000 });

    // Key order is not semantic; reordering must not look like a new command.
    const reordered = acceptCommand(db, command({ payload: { b: 2, a: 1 } }), { now: 2_000 });
    expect(reordered).toEqual({ ok: true, duplicate: true, state: "accepted" });
  });

  test("an expired command is rejected and does not enter the inbox", () => {
    const db = freshDb();
    const result = acceptCommand(
      db,
      command({ issuedAt: "2026-10-23T00:00:00.000Z", expiresAt: "2026-10-23T00:01:00.000Z" }),
      { now: Date.parse("2026-10-23T00:02:00.000Z") },
    );

    // §9.5: an accepted-but-stale start must not launch hours later.
    expect(result).toEqual({ ok: false, reason: "expired" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM command_inbox").get()).toEqual({ n: 0 });
  });

  test("a command addressed to another runner is rejected", () => {
    const db = freshDb();
    const result = acceptCommand(db, command({ runnerId: "runner-b" }), {
      now: 1_000,
      localRunnerId: "runner-a",
    });
    expect(result).toEqual({ ok: false, reason: "wrong_runner" });
  });

  test("an unsupported protocol version is rejected, not ignored", () => {
    const db = freshDb();
    // §17.4: unsupported critical commands must be rejected, never ACKed blindly.
    const result = acceptCommand(db, command({ protocolVersion: 99 as never }), { now: 1_000 });
    expect(result).toEqual({ ok: false, reason: "unsupported_protocol" });
  });

  test("state transitions are monotonic: a finished command is not re-accepted", () => {
    const db = freshDb();
    acceptCommand(db, command(), { now: 1_000 });
    db.prepare("UPDATE command_inbox SET state = 'finished' WHERE command_id = ?").run("cmd-1");

    const again = acceptCommand(db, command(), { now: 2_000 });
    expect(again).toEqual({ ok: true, duplicate: true, state: "finished" });
  });
});
