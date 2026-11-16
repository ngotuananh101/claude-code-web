import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "./db.ts";
import { ingestEvent, type JournalEvent } from "./journal.ts";
import { deleteRunner } from "./runner-tokens.ts";
import * as history from "./session-history.ts";
import { deleteSession, ensureSessionPin } from "./sessions.ts";

function fixture() {
  const db = new Database(":memory:");
  migrate(db);
  let sequence = 0;
  const append = (type: string, payload: unknown, runId = "run-1") => {
    sequence++;
    const event: JournalEvent = {
      eventId: `event-${sequence}`,
      runnerId: "runner",
      bootId: "boot",
      sessionId: "session",
      runId,
      attemptId: `attempt-${runId}`,
      localSequence: sequence,
      occurredAt: "2026-11-16T00:00:00Z",
      type,
      payload,
    };
    ingestEvent(db, event);
    return event;
  };
  return { db, append };
}

const read = (db: Database, options: { before?: number; resetSequence?: number } = {}) =>
  history.readSessionHistory(db, "session", options);

// Removing the indexed page limit must expose more than twelve bubbles.
describe("indexed session history", () => {
  test("cold open returns twelve newest bubbles and older pages are exclusive", () => {
    const { db, append } = fixture();
    for (let i = 1; i <= 15; i++) {
      append("run.started", { prompt: `prompt ${i}` }, `run-${i}`);
      append("message.delta", { messageId: `m-${i}`, text: `answer ${i}` }, `run-${i}`);
      append("run.finished", {}, `run-${i}`);
    }
    const page = read(db);
    expect(page.turns).toHaveLength(12);
    expect(page.turns[0]!.events[0]!.payload).toEqual({ prompt: "prompt 10" });
    expect(page.turns.at(-1)!.kind).toBe("agent");
    expect(page.hasMore).toBe(true);
    const older = read(db, { before: page.before!, resetSequence: page.resetSequence });
    expect(older.turns).toHaveLength(12);
    expect(older.turns[0]!.events[0]!.payload).toEqual({ prompt: "prompt 4" });
    expect(older.turns.at(-1)!.cursor).toBeLessThan(page.turns[0]!.cursor);
    const oldest = read(db, { before: older.before!, resetSequence: older.resetSequence });
    expect(oldest.turns).toHaveLength(6);
    expect(oldest.hasMore).toBe(false);
    expect(db.query("SELECT COUNT(*) AS n FROM run_events").get()).toEqual({ n: 45 });
    db.close();
  });

  test("coalesces a thousand deltas without losing text or tool boundaries", () => {
    const { db, append } = fixture();
    append("run.started", { prompt: "hello" });
    for (let i = 0; i < 1000; i++) append("message.delta", { messageId: "m", text: "x" });
    append("tool.started", { toolCallId: "tool", toolName: "Read" });
    append("tool.completed", { toolCallId: "tool", outputSummary: "ok" });
    append("message.delta", { messageId: "m", text: "end" });
    append("run.finished", {});
    const agent = read(db).turns[1]!;
    expect(agent.events.map((e) => e.type)).toEqual([
      "run.started",
      "message.delta",
      "tool.started",
      "tool.completed",
      "message.delta",
      "run.finished",
    ]);
    expect(agent.events[1]!.payload).toEqual({ messageId: "m", text: "x".repeat(1000) });
    expect(agent.events[4]!.payload).toEqual({ messageId: "m", text: "end" });
    expect(db.query("SELECT COUNT(*) AS n FROM run_events").get()).toEqual({ n: 1005 });
    db.close();
  });

  test.each([null, false, 42, "unstructured"])(
    "unstructured payload %j cannot roll back later valid journal ingestion",
    (payload) => {
      const { db, append } = fixture();
      try {
        append("run.started", { prompt: "hello" });
        expect(() => {
          append("message.delta", payload);
          append("message.delta", { text: "valid one" });
          append("message.delta", payload);
          append("message.delta", { text: "valid two" });
          append("approval.requested", payload);
          append("approval.requested", { approvalId: "real" });
          append("approval.resolved", { approvalId: "real", decision: "allow" });
          append("run.finished", {});
        }).not.toThrow();
        const agent = read(db).turns.find((turn) => turn.kind === "agent")!;
        expect(
          agent.events
            .filter(
              (event) =>
                event.type === "message.delta" &&
                typeof event.payload === "object" &&
                event.payload !== null,
            )
            .map((event) => (event.payload as { text: string }).text)
            .join(""),
        ).toBe("valid onevalid two");
        expect(db.query("SELECT COUNT(*) AS n FROM run_events").get()).toEqual({ n: 9 });
      } finally {
        db.close();
      }
    },
  );

  test("reset hides old turns and refuses an old conversation cursor", () => {
    const { db, append } = fixture();
    append("run.started", { prompt: "old" });
    append("run.finished", {});
    const old = read(db);
    append("session.updated", { type: "conversation_reset", new_conversation_id: "new" });
    append("run.started", { prompt: "new" }, "run-new");
    const current = read(db);
    expect(current.turns).toHaveLength(2);
    expect(current.resetSequence).toBe(3);
    expect(current.hasMore).toBe(false);
    expect(() => read(db, { before: old.before!, resetSequence: old.resetSequence })).toThrow(
      "history_reset",
    );
    db.close();
  });

  test("child activity cannot create main bubbles and telemetry is not delivered", () => {
    const { db, append } = fixture();
    append("run.started", { prompt: "main" });
    append("run.status", { type: "system", subtype: "thinking_tokens", thinking_tokens: 50 });
    append("message.delta", { parentToolUseId: "child", text: "child text" });
    append("run.finished", {});
    expect(read(db).turns).toHaveLength(2);
    expect(read(db).turns[1]!.events.map((e) => e.type)).toEqual([
      "run.started",
      "message.delta",
      "run.finished",
    ]);
    db.close();
  });

  test.each(["session", "runner"])("deleting a %s also removes compact history", (target) => {
    const { db, append } = fixture();
    db.query("INSERT INTO runners (id, owner_id, created_at) VALUES ('runner', 'owner', 1)").run();
    ensureSessionPin(db, {
      sessionId: "session",
      ownerId: "owner",
      workspaceId: "ws",
      runnerId: "runner",
    });
    append("run.started", { prompt: "private history" });
    append("message.delta", { text: "answer" });
    if (target === "session") deleteSession(db, "session", "owner");
    else deleteRunner(db, "runner", "owner");
    expect(read(db).turns).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM session_history_state").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM session_history_chunks").get()).toEqual({ n: 0 });
    db.close();
  });

  test("large text streams use bounded storage chunks while preserving complete text", () => {
    const { db, append } = fixture();
    append("run.started", { prompt: "large" });
    for (let i = 0; i < 40; i++) append("message.delta", { text: "x".repeat(1024) });
    const agent = read(db).turns[1]!;
    expect(
      agent.events
        .filter((event) => event.type === "message.delta")
        .map((event) => (event.payload as { text: string }).text)
        .join(""),
    ).toBe("x".repeat(40960));
    const chunks = db.query("SELECT event FROM session_history_chunks WHERE cursor = 3").all() as {
      event: string;
    }[];
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.event.length < 18000)).toBe(true);
    db.close();
  });

  test("wrapper-only prompts create no user turn so a page holds twelve real bubbles", () => {
    const { db, append } = fixture();
    append("run.started", { prompt: "real one" }, "r-1");
    append("message.delta", { text: "answer one" }, "r-1");
    append("run.finished", {}, "r-1");
    append("run.started", { prompt: "<system-reminder>injected context</system-reminder>" }, "r-2");
    append("message.delta", { text: "scheduled answer" }, "r-2");
    append("run.finished", {}, "r-2");
    const page = read(db);
    expect(page.turns.map((turn) => turn.kind)).toEqual(["user", "agent", "agent"]);
    expect(page.turns[0]!.events[0]!.payload).toEqual({ prompt: "real one" });
    db.close();
  });

  test("bootstrap context retains unresolved gates outside the selected page", () => {
    const { db, append } = fixture();
    append("run.started", { prompt: "old" });
    append("approval.requested", { approvalId: "pending", parentToolUseId: "child" });
    append("run.finished", {});
    for (let i = 0; i < 7; i++) {
      append("run.started", { prompt: "later" }, `r-${i}`);
      append("run.finished", {}, `r-${i}`);
    }
    expect(read(db).context.map((event) => event.payload)).toContainEqual({
      approvalId: "pending",
      parentToolUseId: "child",
    });
    append("approval.resolved", { approvalId: "pending" });
    expect(read(db).context).toEqual([]);
    db.close();
  });

  test("migration backfills existing rows once and duplicate delivery adds no turn", () => {
    const { db, append } = fixture();
    const event = append("run.started", { prompt: "existing" });
    append("message.delta", { text: "answer" });
    append("run.finished", {});
    db.exec(
      "DELETE FROM session_history_chunks; DELETE FROM session_history_turns; DELETE FROM session_history_state; DELETE FROM session_history_projection;",
    );
    migrate(db);
    expect(read(db).turns).toHaveLength(2);
    migrate(db);
    ingestEvent(db, event);
    expect(read(db).turns).toHaveLength(2);
    expect(db.query("SELECT COUNT(*) AS n FROM run_events").get()).toEqual({ n: 3 });
    db.close();
  });
});
