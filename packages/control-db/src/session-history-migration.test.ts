import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "./db.ts";
import { readSessionHistory } from "./session-history.ts";

// Bun has no SQL trace hook. Forward every statement to the real in-memory
// database and observe only accesses at our SQL boundary, including exec's MAX.
class ObservedDatabase extends Database {
  readonly journalReads: string[] = [];
  observe = false;
  override query: Database["query"] = (sql) => {
    this.observeRead(sql);
    return super.query(sql);
  };
  override prepare: Database["prepare"] = (sql, params) => {
    this.observeRead(sql);
    return super.prepare(sql, params);
  };
  override run: Database["run"] = (sql, ...bindings) => {
    this.observeRead(sql);
    return super.run(sql, ...bindings);
  };
  override exec: Database["exec"] = (sql, ...bindings) => {
    this.observeRead(sql);
    return super.exec(sql, ...bindings);
  };
  private observeRead(sql: string): void {
    if (this.observe && /\b(?:FROM|JOIN)\s+run_events\b/i.test(sql)) this.journalReads.push(sql);
  }
}

function insertRaw(db: Database, sequence: number, type: string, payload: string, session = "s") {
  db.query(`INSERT INTO run_events (event_id, runner_id, boot_id, session_id, run_id,
    attempt_id, local_sequence, session_sequence, type, payload, occurred_at, ingested_at)
    VALUES (?, 'runner', 'boot', ?, 'run', ?, ?, ?, ?, ?, '2026-11-16T00:00:00Z', 1)`).run(
    `${session}-${sequence}`,
    session,
    `attempt-${session}`,
    sequence,
    sequence,
    type,
    payload,
  );
}

function legacyFixture(): ObservedDatabase {
  const db = new ObservedDatabase(":memory:");
  migrate(db);
  db.exec("DROP TABLE IF EXISTS session_history_projection");
  insertRaw(db, 1, "run.started", '{"prompt":"original"}');
  insertRaw(db, 2, "message.delta", '{"messageId":"m","text":"a"}');
  insertRaw(db, 3, "message.delta", '{"messageId":"m","text":"b"}');
  insertRaw(db, 4, "run.finished", "{}");
  db.exec(`INSERT INTO session_history_state VALUES ('s', 999, 0, NULL, 0, '[]');
    INSERT INTO session_history_turns VALUES ('s', 999, 'agent', 0);
    INSERT INTO session_history_chunks VALUES ('s', 999, 0, '{"stale":true}');`);
  return db;
}

function setOldVersion(db: Database): void {
  db.exec(`CREATE TABLE session_history_projection (
    id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL
  ); INSERT INTO session_history_projection VALUES (1, 0);`);
}

function projectionSnapshot(db: Database) {
  return [
    db.query("SELECT * FROM session_history_state ORDER BY session_id").all(),
    db.query("SELECT * FROM session_history_turns ORDER BY session_id, cursor").all(),
    db.query("SELECT * FROM session_history_chunks ORDER BY session_id, cursor, chunk_index").all(),
  ];
}

function rawSnapshot(db: Database) {
  return db.query("SELECT * FROM run_events ORDER BY session_id, session_sequence").all();
}

describe("session history projection migration", () => {
  // Removing the version gate would issue both the filtered scan and MAX scan.
  test("a current projection makes repeated migrate skip all raw journal reads", () => {
    using db = new ObservedDatabase(":memory:");
    migrate(db);
    db.observe = true;
    migrate(db);
    migrate(db);
    expect(db.journalReads).toEqual([]);
  });

  // Trusting legacy state.last_sequence would leave the stale turn in place.
  test("an unversioned projection is rebuilt from raw events, not incrementally trusted", () => {
    using db = legacyFixture();
    const raw = rawSnapshot(db);
    migrate(db);
    const page = readSessionHistory(db, "s");
    expect(page.turns.map((turn) => turn.cursor)).toEqual([2, 3]);
    expect(page.turns[0]!.events[0]!.payload).toEqual({ prompt: "original" });
    expect(page.turns[1]!.events.map((event) => event.type)).toEqual([
      "run.started",
      "message.delta",
      "run.finished",
    ]);
    expect(page.turns[1]!.events[1]!.payload).toEqual({ messageId: "m", text: "ab" });
    expect(page.watermark).toBe(4);
    expect(rawSnapshot(db)).toEqual(raw);
    db.observe = true;
    migrate(db);
    expect(db.journalReads).toEqual([]);
  });

  // Skipping an old marker would keep obsolete projection semantics forever.
  test("a different projection version rebuilds stale rows and commits the new gate", () => {
    using db = legacyFixture();
    setOldVersion(db);
    const raw = rawSnapshot(db);
    migrate(db);
    expect(readSessionHistory(db, "s").turns.map((turn) => turn.cursor)).toEqual([2, 3]);
    const applied = db
      .query("SELECT version FROM session_history_projection WHERE id = 1")
      .get() as { version: number };
    expect(applied.version).toBeGreaterThan(0);
    expect(rawSnapshot(db)).toEqual(raw);
    db.observe = true;
    migrate(db);
    expect(db.journalReads).toEqual([]);
  });

  // Clearing outside the transaction or marking before completion loses data.
  test.each([false, true])(
    "a failed rebuild preserves the old projection and marker (versioned=%s)",
    (versioned) => {
      using db = legacyFixture();
      if (versioned) setOldVersion(db);
      insertRaw(db, 5, "message.delta", "{");
      const projection = projectionSnapshot(db);
      const raw = rawSnapshot(db);
      expect(() => migrate(db)).toThrow();
      expect(projectionSnapshot(db)).toEqual(projection);
      expect(rawSnapshot(db)).toEqual(raw);
      expect(db.query("SELECT version FROM session_history_projection WHERE id = 1").get()).toEqual(
        versioned ? { version: 0 } : null,
      );
    },
  );

  // Filtering telemetry must not reduce watermark coverage of the durable log.
  test("rebuild watermarks include filtered-only sessions and retain reset scope", () => {
    using db = legacyFixture();
    insertRaw(
      db,
      5,
      "session.updated",
      '{"type":"conversation_reset","new_conversation_id":"new"}',
    );
    insertRaw(db, 6, "run.started", '{"prompt":"after reset"}');
    insertRaw(db, 7, "run.finished", "{}");
    insertRaw(db, 8, "run.status", '{"type":"system","subtype":"thinking_tokens"}');
    insertRaw(db, 1, "run.status", '{"type":"system","subtype":"thinking_tokens"}', "telemetry");
    const raw = rawSnapshot(db);
    migrate(db);
    const page = readSessionHistory(db, "s");
    expect(page.turns.map((turn) => turn.cursor)).toEqual([12, 13]);
    expect(page.resetSequence).toBe(5);
    expect(page.watermark).toBe(8);
    const telemetry = readSessionHistory(db, "telemetry");
    expect(telemetry.turns).toEqual([]);
    expect(telemetry.watermark).toBe(1);
    expect(rawSnapshot(db)).toEqual(raw);
  });
});

describe("synthetic session history benchmark", () => {
  const script = new URL("../../../scripts/benchmark-session-history.ts", import.meta.url).pathname;

  // A benchmark that times seeding as migration or selects the whole transcript
  // would hide the production boundary this script is intended to measure.
  test("reports separate migration/page timings and twelve-turn pages on synthetic rows", () => {
    const result = Bun.spawnSync([
      process.execPath,
      script,
      "--rows",
      "2048",
      "--sessions",
      "2",
      "--repeats",
      "2",
      "--page-reads",
      "3",
    ]);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout.toString());
    expect(report.storage).toBe(":memory:");
    expect(report.synthetic).toBe(true);
    expect(report.rawRows).toBe(2048);
    expect(report.sessions).toBe(2);
    expect(report.compactTurns).toBe(64);
    expect(report.seedMs).toBeGreaterThanOrEqual(0);
    expect(report.initialMigrationMs).toBeGreaterThanOrEqual(0);
    expect(report.repeatMigrationMs).toHaveLength(2);
    expect(report.repeatMigrationMs.every((ms: number) => ms >= 0)).toBe(true);
    expect(report.page.newest.turns).toBe(12);
    expect(report.page.older.turns).toBe(12);
    expect(report.page.newest.hasMore).toBe(true);
    expect(report.page.older.before).toBeLessThan(report.page.newest.before);
    expect(report.page.repeatReadMs).toHaveLength(3);
  });

  // Accepting any supplied DB path would make this unsafe to repeat on real data.
  test("rejects a database path instead of opening a user's database", () => {
    const result = Bun.spawnSync([process.execPath, script, "--db", "/not-a-synthetic-database"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Unknown option: --db");
    expect(result.stdout.toString()).toBe("");
  });
});
