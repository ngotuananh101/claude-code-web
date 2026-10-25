import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "./db.ts";
import { ensureSessionPin, sessionPin } from "./sessions.ts";

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
