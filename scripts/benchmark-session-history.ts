import { Database } from "bun:sqlite";
import { migrate } from "../packages/control-db/src/db.ts";
import { readSessionHistory } from "../packages/control-db/src/session-history.ts";

/**
 * Repeatable synthetic-only benchmark. Never opens CC_WEB_DB or any disk path.
 * bun scripts/benchmark-session-history.ts --rows 200000 --sessions 20 --repeats 5
 * Seeding is outside the timed initial migration; every run creates a new DB.
 * Timings are observations, not pass/fail latency thresholds.
 */
const EVENTS_PER_RUN = 64;
const DEFAULTS = { rows: 200_000, sessions: 20, repeats: 5, "page-reads": 100 };

function options(args: string[]): typeof DEFAULTS {
  const result = { ...DEFAULTS };
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]!;
    const key = option.slice(2) as keyof typeof DEFAULTS;
    if (!option.startsWith("--") || !Object.hasOwn(DEFAULTS, key)) {
      throw new Error(`Unknown option: ${option}`);
    }
    const raw = args[index + 1];
    const value = Number(raw);
    if (raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${option} requires a positive safe integer`);
    }
    result[key] = value;
  }
  if (Math.floor(result.rows / result.sessions) < EVENTS_PER_RUN * 12) {
    throw new Error("--rows must provide at least twelve complete runs per session");
  }
  return result;
}

function seed(db: Database, rows: number, sessions: number): void {
  const insert = db.prepare(`INSERT INTO run_events (event_id, runner_id, boot_id, session_id,
    run_id, attempt_id, local_sequence, session_sequence, type, payload, occurred_at, ingested_at)
    VALUES (?, 'synthetic-runner', 'synthetic-boot', ?, ?, ?, ?, ?, ?, ?, '2026-11-16T00:00:00Z', 1)`);
  const delta = JSON.stringify({ messageId: "synthetic-message", text: "x".repeat(128) });
  db.transaction(() => {
    for (let session = 0; session < sessions; session++) {
      const sessionId = `synthetic-session-${session}`;
      const count = Math.floor(rows / sessions) + (session < rows % sessions ? 1 : 0);
      for (let sequence = 1; sequence <= count; sequence++) {
        const slot = (sequence - 1) % EVENTS_PER_RUN;
        const run = Math.floor((sequence - 1) / EVENTS_PER_RUN);
        const runId = `${sessionId}-run-${run}`;
        let type: string;
        let payload: string;
        if (slot === 0) {
          type = "run.started";
          payload = JSON.stringify({ prompt: `Synthetic prompt ${run}` });
        } else if (slot === 61) {
          type = "tool.started";
          payload =
            '{"toolCallId":"synthetic-tool","toolName":"Read","inputSummary":"synthetic input"}';
        } else if (slot === 62) {
          type = "tool.completed";
          payload = '{"toolCallId":"synthetic-tool","outputSummary":"synthetic output"}';
        } else if (slot === 63) {
          type = "run.finished";
          payload = "{}";
        } else {
          type = "message.delta";
          payload = delta;
        }
        insert.run(
          `${sessionId}-event-${sequence}`,
          sessionId,
          runId,
          runId,
          slot + 1,
          sequence,
          type,
          payload,
        );
      }
    }
  })();
  insert.finalize();
}

function measured<T>(action: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = action();
  return { value, ms: Number((performance.now() - start).toFixed(3)) };
}

function benchmark(config: typeof DEFAULTS) {
  using db = new Database(":memory:");
  // Create current schema, then model an existing unversioned journal. Ingestion
  // is deliberately bypassed: the first timed migrate must do the entire rebuild.
  migrate(db);
  db.exec("DELETE FROM session_history_projection");
  const seedMs = measured(() => seed(db, config.rows, config.sessions)).ms;
  const initialMigrationMs = measured(() => migrate(db)).ms;
  const repeatMigrationMs = Array.from(
    { length: config.repeats },
    () => measured(() => migrate(db)).ms,
  );
  const session = "synthetic-session-0";
  const newest = measured(() => readSessionHistory(db, session));
  const older = measured(() =>
    readSessionHistory(db, session, {
      before: newest.value.before!,
      resetSequence: newest.value.resetSequence,
    }),
  );
  const repeatReadMs = Array.from(
    { length: config["page-reads"] },
    () => measured(() => readSessionHistory(db, session)).ms,
  );
  const count = (table: string) =>
    (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const page = (result: typeof newest) => ({
    ms: result.ms,
    turns: result.value.turns.length,
    events: result.value.turns.reduce((sum, turn) => sum + turn.events.length, 0),
    bytes: Buffer.byteLength(JSON.stringify(result.value)),
    hasMore: result.value.hasMore,
    before: result.value.before,
  });
  if (
    count("run_events") !== config.rows ||
    newest.value.turns.length !== 12 ||
    older.value.turns.length !== 12
  ) {
    throw new Error("Synthetic row/page invariant failed");
  }
  return {
    synthetic: true,
    storage: ":memory:",
    bunVersion: Bun.version,
    rawRows: count("run_events"),
    sessions: config.sessions,
    eventsPerRun: EVENTS_PER_RUN,
    compactTurns: count("session_history_turns"),
    compactChunks: count("session_history_chunks"),
    seedMs,
    initialMigrationMs,
    repeatMigrationMs,
    page: { newest: page(newest), older: page(older), repeatReadMs },
  };
}

try {
  console.log(JSON.stringify(benchmark(options(process.argv.slice(2))), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
