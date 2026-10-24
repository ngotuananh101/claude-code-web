/**
 * better-auth instance (ADR-0002) — web authentication for the Control Server.
 *
 * Owns sign-up, sign-in (username + password) and session cookies end to end;
 * nothing hand-rolled remains on this path (§19.1: no self-built crypto). The
 * instance is mounted at `/api/auth/*` by `server.ts` and every former
 * "is this cookie valid?" call site resolves through `auth.api.getSession`,
 * which reads the `session` table on every check — revocation applies to the
 * next request, not the next restart.
 *
 * The UX is username-only; better-auth's engine is email+password, so seeded
 * users carry a synthetic `@users.cc-web.local` address and nobody types one.
 */

import type { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins/username";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";

export type CreateBetterAuthOptions = {
  /** Canonical server origin, e.g. http://localhost:8787. */
  baseURL: string;
  /** §19.1: the same origin allowlist the browser gateway enforces. */
  trustedOrigins: string[];
  /**
   * Called when a session row is deleted (sign-out). Wiring this to
   * `BrowserGateway.revoke` is what keeps a signed-out login from keeping its
   * live event socket — the old `tokenVersion` bump, rebuilt on sessions.
   */
  onSessionDelete?: (userId: string) => void;
};

export function createBetterAuth(db: Database, options: CreateBetterAuthOptions) {
  // The `{ db, type, transaction }` wrapper is better-auth's explicit-adapter
  // branch: it takes the Kysely instance as-is, with no instanceof checks, so
  // the library-bundled and app-level kysely copies never have to agree on a
  // class identity. The instance itself drives kysely-bun-sqlite, which reuses
  // this very `Database` handle — auth reads and writes land in the same
  // database every other repository sees. (Handing better-auth the raw handle
  // instead gives it a private `:memory:` copy of its own; passing a bare
  // Kysely instance or a `{ dialect }` object trips its identity sniffing.)
  const kysely = new Kysely({ dialect: new BunSqliteDialect({ database: db }) });

  return betterAuth({
    database: { db: kysely, type: "sqlite", transaction: true },
    baseURL: options.baseURL,
    trustedOrigins: options.trustedOrigins,
    emailAndPassword: { enabled: true },
    plugins: [username({ displayUsername: false })],
    advanced: {
      databaseHooks: {
        session: {
          delete: {
            after: (session) => {
              options.onSessionDelete?.(session.userId);
            },
          },
        },
      },
    },
  });
}

/**
 * Creates an owner through the library's own sign-up path so the password
 * lands in `account.password` in the format it verifies — no hand-rolled
 * hashing anywhere (§19.1).
 */
export async function signUpOwner(
  auth: ReturnType<typeof createBetterAuth>,
  input: { username: string; password: string },
) {
  const result = await auth.api.signUpEmail({
    body: {
      email: `${input.username}@users.cc-web.local`,
      password: input.password,
      name: input.username,
      username: input.username,
      callbackURL: "/",
    },
  });
  return { user: result.user };
}
