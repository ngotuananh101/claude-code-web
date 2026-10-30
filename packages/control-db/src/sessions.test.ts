import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { insertSessionAttachment } from "./attachments.ts";
import { migrate } from "./db.ts";
import { deleteSession, ensureSessionPin, sessionPin, updateSessionTitle } from "./sessions.ts";

/**
 * The session pin (§2.3, ADR-006): an accepted dispatch records which
 * (workspace, runner) a session ran on, and every later run of that session
 * rides the pin instead of re-running placement. An interactive session must
 * never split across runners — the SDK conversation lives on one machine.
 *
 * The pin is immutable: first pin wins, written with INSERT OR IGNORE. Moving
 * a session is §21.6 migration, a different milestone with a different design.
 */

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

describe("session pins", () => {
  test("the first pin for a session is stored", () => {
    const db = setup();

    ensureSessionPin(db, {
      sessionId: "session-1",
      ownerId: "user-1",
      workspaceId: "ws",
      runnerId: "runner-a",
    });

    expect(sessionPin(db, "session-1")).toEqual({
      sessionId: "session-1",
      ownerId: "user-1",
      workspaceId: "ws",
      runnerId: "runner-a",
    });
  });

  test("the first pin wins — a later dispatch cannot move it", () => {
    const db = setup();
    ensureSessionPin(db, {
      sessionId: "session-1",
      ownerId: "user-1",
      workspaceId: "ws",
      runnerId: "runner-a",
    });

    ensureSessionPin(db, {
      sessionId: "session-1",
      ownerId: "user-1",
      workspaceId: "ws",
      runnerId: "runner-b",
    });

    expect(sessionPin(db, "session-1")?.runnerId).toBe("runner-a");
  });

  test("an unknown session has no pin", () => {
    const db = setup();

    expect(sessionPin(db, "nobody")).toBeUndefined();
  });
});

describe("session rename and delete", () => {
  test("updateSessionTitle updates title when owner matches", () => {
    const db = setup();
    ensureSessionPin(db, {
      sessionId: "session-1",
      ownerId: "user-1",
      workspaceId: "ws",
      runnerId: "runner-a",
    });

    const updated = updateSessionTitle(db, "session-1", "user-1", "Dự án mới");
    expect(updated).toBe(true);

    const pin = sessionPin(db, "session-1");
    expect(pin?.title).toBe("Dự án mới");
  });

  test("updateSessionTitle refuses when owner does not match", () => {
    const db = setup();
    ensureSessionPin(db, {
      sessionId: "session-1",
      ownerId: "user-1",
      workspaceId: "ws",
      runnerId: "runner-a",
    });

    const updated = updateSessionTitle(db, "session-1", "user-2", "Dự án giả");
    expect(updated).toBe(false);
  });

  test("deleteSession deletes session and associated records", () => {
    const db = setup();
    ensureSessionPin(db, {
      sessionId: "session-1",
      ownerId: "user-1",
      workspaceId: "ws",
      runnerId: "runner-a",
    });

    db.prepare(
      "INSERT INTO run_events (event_id, runner_id, boot_id, session_id, run_id, attempt_id, local_sequence, session_sequence, type, payload, occurred_at, ingested_at) VALUES ('e1', 'runner-a', 'b1', 'session-1', 'r1', 'a1', 1, 1, 'test', '{}', '2026-10-30T00:00:00Z', 1)",
    ).run();
    db.prepare(
      "INSERT INTO active_runs (run_id, session_id, runner_id, attempt_id, dispatched_at) VALUES ('r1', 'session-1', 'runner-a', 'a1', 1)",
    ).run();
    db.prepare(
      "INSERT INTO approvals (approval_id, session_id, run_id, attempt_id, runner_id, kind, tool_name, input_hash, input_summary, state, expires_at, created_at) VALUES ('ap1', 'session-1', 'r1', 'a1', 'runner-a', 'command', 'bash', 'h', 's', 'pending', 100, 1)",
    ).run();
    db.prepare(
      "INSERT INTO command_outbox (command_id, runner_id, kind, payload, fingerprint, issued_at, session_id, delivery_state, created_at) VALUES ('c1', 'runner-a', 'run.start', '{}', 'fp', 'now', 'session-1', 'queued', 1)",
    ).run();

    const res = deleteSession(db, "session-1", "user-1");
    expect(res.ok).toBe(true);

    expect(sessionPin(db, "session-1")).toBeUndefined();
    expect(
      db.query("SELECT COUNT(*) AS count FROM run_events WHERE session_id = 'session-1'").get(),
    ).toEqual({ count: 0 });
    expect(
      db.query("SELECT COUNT(*) AS count FROM active_runs WHERE session_id = 'session-1'").get(),
    ).toEqual({ count: 0 });
    expect(
      db.query("SELECT COUNT(*) AS count FROM approvals WHERE session_id = 'session-1'").get(),
    ).toEqual({ count: 0 });
    expect(
      db.query("SELECT COUNT(*) AS count FROM command_outbox WHERE session_id = 'session-1'").get(),
    ).toEqual({ count: 0 });
  });

  test("deleteSession refuses when owner does not match", () => {
    const db = setup();
    ensureSessionPin(db, {
      sessionId: "session-1",
      ownerId: "user-1",
      workspaceId: "ws",
      runnerId: "runner-a",
    });

    const res = deleteSession(db, "session-1", "user-2");
    expect(res.ok).toBe(false);
    expect(res.attachmentStoragePaths).toEqual([]);
    expect(sessionPin(db, "session-1")).toBeDefined();
  });

  test("deleteSession returns attachment storage paths for cleanup", () => {
    const db = setup();
    ensureSessionPin(db, {
      sessionId: "session-1",
      ownerId: "user-1",
      workspaceId: "ws",
      runnerId: "runner-a",
    });

    insertSessionAttachment(db, {
      id: "att-1",
      sessionId: "session-1",
      ownerId: "user-1",
      name: "file.png",
      mimeType: "image/png",
      size: 2048,
      storagePath: "/disk/att-1",
      createdAt: 1000,
    });
    insertSessionAttachment(db, {
      id: "att-2",
      sessionId: "session-1",
      ownerId: "user-1",
      name: "doc.pdf",
      mimeType: "application/pdf",
      size: 4096,
      storagePath: "/disk/att-2",
      createdAt: 1000,
    });

    const res = deleteSession(db, "session-1", "user-1");
    expect(res.ok).toBe(true);
    expect(res.attachmentStoragePaths.sort()).toEqual(["/disk/att-1", "/disk/att-2"]);

    // The session itself is gone.
    expect(sessionPin(db, "session-1")).toBeUndefined();
  });
});
