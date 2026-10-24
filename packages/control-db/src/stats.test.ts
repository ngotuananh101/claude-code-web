import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate } from "./db.ts";
import { ingestEvent, type JournalEvent } from "./journal.ts";
import { usageStats } from "./stats.ts";

/**
 * The dashboard's read model: token usage aggregated out of the journal.
 *
 * Usage lives on `message.completed` payloads — the SDK's assistant messages
 * carry `message.usage` with the API's token accounting, and the redactor
 * keeps token counts while stripping cost figures (§19.4). Summing any other
 * frame (the `result` frame repeats the turn's totals) would double-count.
 */

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-24T12:00:00.000Z");

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare(
    "INSERT INTO runners (id, owner_id, created_at) VALUES ('runner-a', 'owner-1', ?)",
  ).run(NOW - 10 * DAY);
  db.prepare(
    "INSERT INTO runners (id, owner_id, created_at) VALUES ('runner-b', 'owner-2', ?)",
  ).run(NOW - 10 * DAY);
  return db;
}

let counter = 0;

function event(overrides: Partial<JournalEvent> = {}): JournalEvent {
  counter += 1;
  return {
    eventId: `evt-${counter}`,
    runnerId: "runner-a",
    bootId: "boot-1",
    sessionId: "session-1",
    runId: "run-1",
    attemptId: "attempt-1",
    localSequence: counter,
    occurredAt: "2026-10-24T10:00:00.000Z",
    type: "run.started",
    payload: {},
    ...overrides,
  };
}

function usagePayload(usage: Record<string, number>): Record<string, unknown> {
  return { type: "assistant", message: { usage } };
}

test("sums the four token figures across message.completed events", () => {
  const db = setup();
  ingestEvent(
    db,
    event({
      type: "message.completed",
      payload: usagePayload({
        input_tokens: 100,
        cache_read_input_tokens: 1_000,
        cache_creation_input_tokens: 200,
        output_tokens: 50,
      }),
    }),
  );
  ingestEvent(
    db,
    event({
      type: "message.completed",
      payload: usagePayload({
        input_tokens: 11,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 9,
        output_tokens: 4,
      }),
    }),
  );

  const stats = usageStats(db, "owner-1", { now: NOW });
  expect(stats.totals).toEqual({
    inputTokens: 111,
    cacheReadTokens: 1_000,
    cacheCreationTokens: 209,
    outputTokens: 54,
  });
});

test("frames without usage and other event types contribute nothing", () => {
  const db = setup();
  ingestEvent(db, event({ type: "message.completed", payload: { text: "no usage here" } }));
  ingestEvent(db, event({ type: "run.started", payload: { commandId: "cmd-1" } }));
  ingestEvent(db, event({ type: "run.finished", payload: { reason: "completed" } }));

  const stats = usageStats(db, "owner-1", { now: NOW });
  expect(stats.totals).toEqual({
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
  });
});

test("daily buckets follow occurred_at, zero-filled to the window's edge", () => {
  const db = setup();
  ingestEvent(
    db,
    event({
      type: "message.completed",
      occurredAt: "2026-10-24T01:00:00.000Z",
      payload: usagePayload({ input_tokens: 10, output_tokens: 2 }),
    }),
  );
  ingestEvent(
    db,
    event({
      type: "message.completed",
      occurredAt: "2026-10-22T23:00:00.000Z",
      payload: usagePayload({ input_tokens: 5, output_tokens: 1 }),
    }),
  );

  const stats = usageStats(db, "owner-1", { now: NOW, days: 3 });
  expect(stats.daily).toEqual([
    {
      day: "2026-10-22",
      inputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 1,
    },
    {
      day: "2026-10-23",
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
    },
    {
      day: "2026-10-24",
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 2,
    },
  ]);
});

test("totals stay all-time while the daily window is bounded", () => {
  const db = setup();
  ingestEvent(
    db,
    event({
      type: "message.completed",
      occurredAt: new Date(NOW - 30 * DAY).toISOString(),
      payload: usagePayload({ input_tokens: 7 }),
    }),
  );
  ingestEvent(
    db,
    event({
      type: "message.completed",
      occurredAt: new Date(NOW - DAY).toISOString(),
      payload: usagePayload({ input_tokens: 3 }),
    }),
  );

  const stats = usageStats(db, "owner-1", { now: NOW, days: 7 });
  expect(stats.totals.inputTokens).toBe(10);
  expect(stats.daily).toHaveLength(7);
  expect(stats.daily.at(-1)?.day).toBe("2026-10-24");
  expect(stats.daily.reduce((sum, day) => sum + day.inputTokens, 0)).toBe(3);
});

test("counts sessions, distinct runs and events for the owner only", () => {
  const db = setup();
  ingestEvent(db, event({ type: "run.started", runId: "run-1" }));
  ingestEvent(
    db,
    event({
      type: "message.completed",
      runId: "run-1",
      payload: usagePayload({ input_tokens: 1 }),
    }),
  );
  ingestEvent(db, event({ sessionId: "session-2", runId: "run-2", type: "run.started" }));
  // A different owner's runner: invisible.
  ingestEvent(
    db,
    event({ runnerId: "runner-b", sessionId: "session-x", runId: "run-x", type: "run.started" }),
  );

  const stats = usageStats(db, "owner-1", { now: NOW });
  expect(stats.sessions).toBe(2);
  expect(stats.runs).toBe(2);
  expect(stats.events).toBe(3);
  expect(stats.totals.inputTokens).toBe(1);
});

test("a session dispatched but not yet journaled still counts", () => {
  const db = setup();
  db.prepare(
    "INSERT INTO active_runs (run_id, session_id, runner_id, attempt_id, dispatched_at) VALUES ('run-9', 'session-live', 'runner-a', 'attempt-9', ?)",
  ).run(NOW);

  const stats = usageStats(db, "owner-1", { now: NOW });
  expect(stats.sessions).toBe(1);
  expect(stats.runs).toBe(1);
});
