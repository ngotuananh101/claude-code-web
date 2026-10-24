/**
 * Seeds a demo database for developing the web client: one owner
 * (`owner` / password on stdin, same rule as seed-user), journal sessions
 * spread over the past two weeks — each carrying `message.completed` usage
 * payloads so the dashboard's token chart has a shape — and one
 * dispatched-but-silent live session: the §16.1 moment the owner most wants
 * to see listed.
 *
 *   bun scripts/seed-demo.ts [db-path] < password.txt
 *
 * The payloads are shaped like real run events (usage on assistant
 * messages, exactly what the runner journals and the dashboard reads) so
 * the transcript and the chart both read like production. Throwaway data by
 * design: point CC_WEB_DB at a scratch copy, never at a database you care
 * about.
 */

import { Database } from "bun:sqlite";
import { ingestEvent, migrate } from "@cc-web/control-db";
import { hashPassword } from "../apps/control-server/src/auth/password.ts";

const dbPath = process.argv[2] ?? "/tmp/cc-web-demo.sqlite";
const db = new Database(dbPath);
migrate(db);

const password = (await new Response(Bun.stdin).text()).trimEnd();
if (password.length === 0) {
  console.error("a password must arrive on stdin");
  process.exit(1);
}

const user = db.query("SELECT id FROM users WHERE username = 'owner'").get() as {
  id: string;
} | null;
if (user === null) {
  db.query(
    "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, 1, ?)",
  ).run(crypto.randomUUID(), "owner", await hashPassword(password), Date.now());
}

db.query(
  "INSERT OR IGNORE INTO runners (id, owner_id, created_at) VALUES ('runner-local', (SELECT id FROM users WHERE username = 'owner'), ?)",
).run(Date.now());

const DAY = 86_400_000;

type Turn = {
  text: string;
  usage: {
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    output_tokens: number;
  };
};

/** One seeded run: started → one message.completed per turn → finished. */
function seed(
  sessionId: string,
  runId: string,
  attemptId: string,
  daysAgo: number,
  turns: Turn[],
): void {
  const at = (offset: number): string =>
    new Date(Date.now() - daysAgo * DAY + offset * 1_000).toISOString();

  const events: Array<{ type: string; payload: unknown; occurredAt: string }> = [
    { type: "run.started", payload: { commandId: "cmd-demo" }, occurredAt: at(0) },
  ];
  turns.forEach((turn, index) => {
    // The narrative arrives as the delta; the accounting arrives with the
    // completed message — the two events a real assistant turn journals.
    events.push({
      type: "message.delta",
      payload: { text: turn.text },
      occurredAt: at(index * 2 + 1),
    });
    events.push({
      type: "message.completed",
      payload: { type: "assistant", message: { usage: turn.usage } },
      occurredAt: at(index * 2 + 2),
    });
  });
  events.push({
    type: "run.finished",
    payload: { reason: "completed" },
    occurredAt: at(turns.length * 2 + 1),
  });

  events.forEach((event, index) => {
    ingestEvent(db, {
      eventId: `evt-${sessionId}-${index}`,
      runnerId: "runner-local",
      bootId: "boot-demo",
      sessionId,
      runId,
      attemptId,
      localSequence: index + 1,
      occurredAt: event.occurredAt,
      // Written by this seeder for this seeder's journal.
      type: event.type as Parameters<typeof ingestEvent>[1]["type"],
      payload: event.payload as never,
    });
  });
}

seed("session-refactor-auth", "run-101", "attempt-101", 6, [
  {
    text: "Move the token check out of the request handler into middleware.",
    usage: {
      input_tokens: 3_412,
      cache_read_input_tokens: 18_204,
      cache_creation_input_tokens: 2_866,
      output_tokens: 511,
    },
  },
  {
    text: "Extracting requireAuth and wiring it into the router pipeline.",
    usage: {
      input_tokens: 1_204,
      cache_read_input_tokens: 24_112,
      cache_creation_input_tokens: 940,
      output_tokens: 388,
    },
  },
  {
    text: "Tests updated: 12 pass, 0 fail. The handler no longer knows about tokens.",
    usage: {
      input_tokens: 986,
      cache_read_input_tokens: 26_301,
      cache_creation_input_tokens: 611,
      output_tokens: 402,
    },
  },
]);

seed("session-flake-hunt", "run-102", "attempt-102", 3, [
  {
    text: "The reconnect test flakes about once in twenty runs — investigating.",
    usage: {
      input_tokens: 2_150,
      cache_read_input_tokens: 9_840,
      cache_creation_input_tokens: 1_530,
      output_tokens: 297,
    },
  },
  {
    text: "The assertion races the socket's close event; adding a settle await.",
    usage: {
      input_tokens: 1_608,
      cache_read_input_tokens: 12_073,
      cache_creation_input_tokens: 742,
      output_tokens: 254,
    },
  },
]);

seed("session-docs-pass", "run-104", "attempt-104", 1, [
  {
    text: "Walking the architecture doc against the shipped routes.",
    usage: {
      input_tokens: 4_020,
      cache_read_input_tokens: 31_508,
      cache_creation_input_tokens: 3_104,
      output_tokens: 766,
    },
  },
  {
    text: "§17.1 now lists /api/stats/usage; the boundary table still holds.",
    usage: {
      input_tokens: 1_733,
      cache_read_input_tokens: 35_977,
      cache_creation_input_tokens: 880,
      output_tokens: 431,
    },
  },
]);

db.query(
  "INSERT OR IGNORE INTO active_runs (run_id, session_id, runner_id, attempt_id, dispatched_at) VALUES ('run-103', 'session-new-prompt', 'runner-local', 'attempt-103', ?)",
).run(Date.now());

console.log(`seeded ${dbPath}`);
