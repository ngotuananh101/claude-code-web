import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandOutbox } from "./command-outbox.ts";
import { migrate } from "./db.ts";
import { JOURNAL_EVENT_SQL } from "./replay-filter.ts";
import { Scheduler } from "./scheduler.ts";

function tableNames(db: Database): string[] {
  return (
    db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  ).map((row) => row.name);
}

describe("migrate", () => {
  test("creates the owner and runner tables", () => {
    const db = new Database(":memory:");
    migrate(db);
    const names = tableNames(db);

    // The owner table (ADR-0001) plus the connector model (ADR-015). The
    // better-auth tables are dropped, not created.
    for (const table of ["users", "runners", "runner_credentials"]) {
      expect(names).toContain(table);
    }
    for (const gone of ["user", "session", "account", "verification", "auth_sessions"]) {
      expect(names).not.toContain(gone);
    }
  });

  test("users carries the token_version column", () => {
    const db = new Database(":memory:");
    migrate(db);

    const columns = (db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(columns).toContain("token_version");
  });

  test("users carries the avatar column", () => {
    const db = new Database(":memory:");
    migrate(db);

    const columns = (db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(columns).toContain("avatar");
  });

  test("adds a nullable retry deadline without changing queued commands from an older database", async () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      await new CommandOutbox(db).enqueue({
        commandId: "old-queued-start",
        runnerId: "runner-a",
        kind: "run.start",
        payload: { prompt: "Keep existing work" },
        issuedAt: "2026-11-20T00:00:00.000Z",
        deliveryState: "queued",
      });
      db.exec("ALTER TABLE command_outbox DROP COLUMN retry_after");
      migrate(db);
      migrate(db);
      expect(db.query("SELECT retry_after FROM command_outbox").get()).toEqual({
        retry_after: null,
      });
      expect(new CommandOutbox(db).queuedFor("runner-a")).toMatchObject([
        { commandId: "old-queued-start", payload: { prompt: "Keep existing work" } },
      ]);
    } finally {
      db.close();
    }
  });

  test("is idempotent", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });
});

describe("workspace retry persistence", () => {
  test("a reopened database keeps a refused start queued until its stored deadline", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cc-web-retry-"));
    const path = join(directory, "control.sqlite");
    let db: Database | undefined;
    const capacity = {
      runnerId: "runner-a",
      state: "ready",
      maxConcurrentRuns: 1,
      activeRuns: 0,
    } as const;
    try {
      db = new Database(path);
      migrate(db);
      let now = 1_000;
      const scheduler = new Scheduler(db, { now: () => now });
      const decision = await scheduler.dispatch(
        {
          sessionId: "session-1",
          ownerId: "user-1",
          workspaceId: "workspace-1",
          runId: "run-1",
          attemptId: "attempt-1",
          prompt: "Wait for cleanup",
        },
        capacity,
      );
      if (!decision.ok || decision.queued) throw new Error("expected admission");
      const outbox = new CommandOutbox(db);
      outbox.markRejected(decision.commandId, "workspace_busy");
      scheduler.release("run-1");
      expect(outbox.requeue(decision.commandId, { now })).toBe("requeued");
      db.close();

      db = new Database(path);
      migrate(db);
      const restarted = new Scheduler(db, { now: () => now });
      now = 1_999;
      expect(restarted.promote("runner-a", capacity)).toEqual([]);
      expect(new CommandOutbox(db).get(decision.commandId)).toMatchObject({
        deliveryState: "queued",
        retryAfter: 2_000,
        requeueCount: 1,
      });
      now = 2_000;
      expect(restarted.promote("runner-a", capacity)).toEqual(["run-1"]);
    } finally {
      db?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("scheduled_tasks migration (§5.3)", () => {
  test("scheduled_tasks and its indexes exist after two migrations", () => {
    const db = new Database(":memory:");
    migrate(db);
    migrate(db); // idempotent: the server calls migrate() on every boot

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_tasks'")
      .all();
    expect(tables).toHaveLength(1);

    const indexes = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('scheduled_tasks_origin_cli', 'scheduled_tasks_due')",
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name).sort()).toEqual([
      "scheduled_tasks_due",
      "scheduled_tasks_origin_cli",
    ]);
  });
});

describe("journal replay index", () => {
  test("existing history gains an idempotent partial index used by the projected range query", () => {
    const db = new Database(":memory:");
    migrate(db);
    // Model an older database with rows but no projected replay index.
    db.exec("DROP INDEX run_events_journal_order");
    db.query(`INSERT INTO run_events (event_id, runner_id, boot_id, session_id, run_id, attempt_id,
      local_sequence, session_sequence, type, payload, occurred_at, ingested_at)
      VALUES ('e', 'r', 'b', 's', 'run', 'a', 1, 1, 'run.status', ?, 'now', 1)`).run(
      JSON.stringify({ type: "system", subtype: "thinking_tokens" }),
    );
    migrate(db);
    migrate(db);
    const plan = db
      .query(`EXPLAIN QUERY PLAN
      SELECT session_sequence, event_id, run_id, attempt_id, occurred_at, type, payload
      FROM run_events WHERE session_id = ? AND session_sequence > ? AND session_sequence <= ?
        AND ${JOURNAL_EVENT_SQL} ORDER BY session_sequence LIMIT ?`)
      .all("s", 0, 100_000, 200) as Array<{ detail: string }>;
    expect(plan.map((item) => item.detail).join("\n")).toContain("run_events_journal_order");
    expect(db.query("SELECT COUNT(*) AS count FROM run_events").get()).toEqual({ count: 1 });
  });
});

describe("run id indexes (§11.5)", () => {
  test("run_events and command_outbox answer run_id lookups from an index", () => {
    // The schedule tick asks "is this deterministic run id known?" for every
    // due row, every 15 seconds. Without these indexes each question is a full
    // scan of the journal and the outbox, which grow with every run.
    const db = new Database(":memory:");
    migrate(db);

    const indexes = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('run_events_run', 'command_outbox_run')",
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name).sort()).toEqual(["command_outbox_run", "run_events_run"]);

    const plan = (sql: string) =>
      (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
        .map((row) => row.detail)
        .join("\n");
    expect(plan("SELECT 1 FROM run_events WHERE run_id = 'r'")).toContain("run_events_run");
    expect(plan("SELECT 1 FROM command_outbox WHERE run_id = 'r'")).toContain("command_outbox_run");
  });
});

describe("scheduled-task indexes (§11.5)", () => {
  test("session lookups answer from an index", () => {
    // The Lịch tab lists one session's active rows on every open; without this
    // index each open is a full scan of a table that keeps a tombstone per
    // schedule ever created.
    const db = new Database(":memory:");
    migrate(db);

    const indexes = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'scheduled_tasks_session'",
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual(["scheduled_tasks_session"]);

    const plan = (
      db
        .query("EXPLAIN QUERY PLAN SELECT * FROM scheduled_tasks WHERE session_id = 's'")
        .all() as Array<{ detail: string }>
    )
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("scheduled_tasks_session");
  });
});

describe("telegram_action_tokens migration", () => {
  test("telegram_action_tokens carries answers and label columns", () => {
    const db = new Database(":memory:");
    migrate(db);

    const columns = (
      db.query("PRAGMA table_info(telegram_action_tokens)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).toContain("answers");
    expect(columns).toContain("label");
  });
});

describe("workspaces.branches migration (M4)", () => {
  test("a database created before the column gains it on migrate", () => {
    const db = new Database(":memory:");
    // The previous schema: create the table without `branches`, as an
    // older release would have.
    db.exec(`
      CREATE TABLE workspaces (
        runner_id     TEXT NOT NULL,
        workspace_id  TEXT NOT NULL,
        path          TEXT NOT NULL,
        registered_at INTEGER NOT NULL,
        PRIMARY KEY (runner_id, workspace_id)
      );
    `);

    migrate(db);

    const columns = (
      db.query("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).toContain("branches");
  });

  test("a fresh database has the column from the start", () => {
    const db = new Database(":memory:");
    migrate(db);
    const columns = (
      db.query("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).toContain("branches");
  });
});

describe("command_outbox queue columns", () => {
  test("command_outbox carries requeue_count and queue_snapshot", () => {
    const db = new Database(":memory:");
    migrate(db);
    const columns = (
      db.query("PRAGMA table_info(command_outbox)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).toContain("requeue_count");
    expect(columns).toContain("queue_snapshot");
  });
});
