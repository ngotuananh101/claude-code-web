/**
 * Seeds an owner account so signing in works on a fresh database (§6, ADR-0002).
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
import { createBetterAuth, signUpOwner } from "../apps/control-server/src/auth/better-auth.ts";

const username = process.argv[2];
if (!username) {
  console.error("usage: bun scripts/seed-user.ts <username>  (password on stdin)");
  process.exit(1);
}

const dbPath = process.env["CC_WEB_DB"] ?? "./data/control.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
migrate(db);

const password = (await new Response(Bun.stdin).text()).trimEnd();
if (password.length === 0) {
  console.error("a password must arrive on stdin");
  process.exit(1);
}

// Sign-up goes through the library's own path so the password lands in
// `account.password` in exactly the format sign-in verifies (§19.1). The
// synthetic email is never typed by anyone: better-auth's engine is
// email+password, the UX is username-only.
const auth = createBetterAuth(db, {
  baseURL: process.env["BETTER_AUTH_URL"] ?? "http://localhost:8787",
  secret: process.env["BETTER_AUTH_SECRET"],
  trustedOrigins: [],
});

try {
  await signUpOwner(auth, { username, password });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE")) {
    console.error(`${username} already exists in ${dbPath}`);
    process.exit(1);
  }
  throw error;
}

console.log(`seeded ${username} in ${dbPath}`);
