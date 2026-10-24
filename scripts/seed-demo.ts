/**
 * Seeds a demo database for developing the web client: one owner
 * (`owner` / password on stdin, same rule as seed-user), one finished
 * session, one two-event session, and one dispatched-but-silent live
 * session — the §16.1 moment the owner most wants to see it listed.
 *
 *   bun scripts/seed-demo.ts [db-path] < password.txt
 *
 * The payloads are shaped like real run events so the journal reads like a
 * transcript. Throwaway data by design: point CC_WEB_DB at a scratch copy,
 * never at a database you care about.
 */

import { Database } from "bun:sqlite";
import { ingestEvent, migrate } from "@cc-web/control-db";
import { createBetterAuth, signUpOwner } from "../apps/control-server/src/auth/better-auth.ts";

const dbPath = process.argv[2] ?? "/tmp/cc-web-demo.sqlite";
const db = new Database(dbPath);
migrate(db);

const password = (await new Response(Bun.stdin).text()).trimEnd();
if (password.length === 0) {
  console.error("a password must arrive on stdin");
  process.exit(1);
}

const user = db.query("SELECT id FROM user WHERE username = 'owner'").get() as {
  id: string;
} | null;
if (user === null) {
  const auth = createBetterAuth(db, {
    baseURL: process.env["BETTER_AUTH_URL"] ?? "http://localhost:8787",
    secret: process.env["BETTER_AUTH_SECRET"],
    trustedOrigins: [],
  });
  await signUpOwner(auth, { username: "owner", password });
}

db.query(
  "INSERT OR IGNORE INTO runners (id, owner_id, created_at) VALUES ('runner-local', (SELECT id FROM user WHERE username = 'owner'), ?)",
).run(Date.now());

function seed(sessionId: string, runId: string, attemptId: string, lines: string[]): void {
  const events: Array<{ type: string; payload: unknown }> = [
    { type: "run.started", payload: { commandId: "cmd-demo" } },
    ...lines.map((line) => ({ type: "message.delta", payload: { text: line } })),
    { type: "run.finished", payload: { reason: "completed" } },
  ];
  events.forEach((event, index) => {
    ingestEvent(db, {
      eventId: `evt-${sessionId}-${index}`,
      runnerId: "runner-local",
      bootId: "boot-demo",
      sessionId,
      runId,
      attemptId,
      localSequence: index + 1,
      occurredAt: new Date(Date.now() - (events.length - index) * 3_000).toISOString(),
      // Written by this seeder for this seeder's journal.
      type: event.type as Parameters<typeof ingestEvent>[1]["type"],
      payload: event.payload as never,
    });
  });
}

seed("session-refactor-auth", "run-101", "attempt-101", [
  "Move the token check out of the request handler into middleware.",
  "Reading the current handler: the verify call is inlined at line 88.",
  "Extracting requireAuth and wiring it into the router pipeline.",
  "Tests updated: 12 pass, 0 fail. The handler no longer knows about tokens.",
]);
seed("session-flake-hunt", "run-102", "attempt-102", [
  "The reconnect test flakes about once in twenty runs — investigating.",
  "The assertion races the socket's close event; adding a settle await.",
]);

db.query(
  "INSERT OR IGNORE INTO active_runs (run_id, session_id, runner_id, attempt_id, dispatched_at) VALUES ('run-103', 'session-new-prompt', 'runner-local', 'attempt-103', ?)",
).run(Date.now());

console.log(`seeded ${dbPath}`);
