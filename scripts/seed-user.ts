/**
 * Seeds an owner account so `/auth/login` works on a fresh database (§6.2).
 *
 * The password is read from stdin, never argv: a process listing is world
 * readable on most systems, and a secret that passes through the command
 * line stays there (the same rule §19.4 sets for enrollment tokens).
 *
 *   bun scripts/seed-user.ts <username> < password.txt
 *   echo -n "…" | bun scripts/seed-user.ts <username>
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "@cc-web/control-db";
import { hashPassword } from "../apps/control-server/src/auth/password.ts";
import { resolveDataPaths } from "../apps/control-server/src/config.ts";

const username = process.argv[2];
if (!username) {
  console.error("usage: bun scripts/seed-user.ts <username>  (password on stdin)");
  process.exit(1);
}

// Same environment resolution as the server, so seeding targets the database
// the server will actually open.
const { dbPath } = resolveDataPaths();
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
migrate(db);

const password = (await new Response(Bun.stdin).text()).trimEnd();
if (password.length === 0) {
  console.error("a password must arrive on stdin");
  process.exit(1);
}

const hash = await hashPassword(password);
try {
  db.query(
    "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, 1, ?)",
  ).run(crypto.randomUUID(), username, hash, Date.now());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE")) {
    console.error(`${username} already exists in ${dbPath}`);
    process.exit(1);
  }
  throw error;
}

console.log(`seeded ${username} in ${dbPath}`);
