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

export type BetterAuthInstance = ReturnType<typeof createBetterAuth>;

export type SessionDeleteHandler = (userId: string) => void;

export type CreateBetterAuthOptions = {
  /** Canonical server origin, e.g. http://localhost:8787. */
  baseURL: string;
  /**
   * Session-signing secret (BETTER_AUTH_SECRET). The entrypoint enforces its
   * length; passing it through keeps the library off ambient environment reads,
   * which tests would otherwise have to fight. `| undefined` because callers
   * naturally forward `process.env` lookups (exactOptionalPropertyTypes).
   */
  secret?: string | undefined;
  /** §19.1: the same origin allowlist the browser gateway enforces. */
  trustedOrigins: string[];
  /**
   * Called when a session row is deleted (sign-out). Wiring this to
   * `BrowserGateway.revoke` is what keeps a signed-out login from keeping its
   * live event socket — the old `tokenVersion` bump, rebuilt on sessions.
   */
  onSessionDelete?: SessionDeleteHandler;
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

  // Late-bound so `createServer` can attach the gateway after the instance was
  // built by `buildServerOptions` — the hook is read at fire time, not captured.
  let sessionDeleteHandler = options.onSessionDelete;

  const auth = betterAuth({
    database: { db: kysely, type: "sqlite", transaction: true },
    baseURL: options.baseURL,
    ...(options.secret === undefined ? {} : { secret: options.secret }),
    trustedOrigins: options.trustedOrigins,
    emailAndPassword: { enabled: true },
    plugins: [username({ displayUsername: false })],
    // Top-level in 1.7.x (not `advanced.databaseHooks`): this is what turns a
    // sign-out into a live-socket revocation when wired to the gateway (§12.5).
    databaseHooks: {
      session: {
        delete: {
          after: async (session) => {
            sessionDeleteHandler?.(session.userId);
          },
        },
      },
    },
  });

  return Object.assign(auth, {
    onSessionDelete(handler: SessionDeleteHandler): void {
      sessionDeleteHandler = handler;
    },
  });
}

/**
 * The "is this Cookie header a live session?" check the browser gateway and the
 * browser HTTP routes share (§19.1).
 *
 * The header travels to better-auth whole: the library parses cookies and knows
 * its own session-cookie name, so nothing here (and nothing in the gateway)
 * hardcodes `better-auth.session_token`. It reads the `session` table on every
 * check, so a deleted session is dead on the next call — the property the old
 * `tokenVersion` bump provided, now the library's job.
 */
export type SessionResolver = (cookieHeader: string | undefined) => Promise<string | null>;

export function createSessionResolver(auth: BetterAuthInstance): SessionResolver {
  return async (cookieHeader) => {
    if (cookieHeader === undefined || cookieHeader === "") return null;
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookieHeader }),
    });
    return session?.user.id ?? null;
  };
}

/**
 * Creates an owner through the library's own sign-up path so the password
 * lands in `account.password` in the format it verifies — no hand-rolled
 * hashing anywhere (§19.1).
 */
export async function signUpOwner(
  auth: BetterAuthInstance,
  input: { username: string; password: string },
) {
  // The username plugin accepts `username` at runtime, but its type
  // augmentation does not survive the wrapper's `ReturnType`, so the body is
  // cast — the library still validates the real request server-side (§19.1).
  const body = {
    email: `${input.username}@users.cc-web.local`,
    password: input.password,
    name: input.username,
    username: input.username,
    callbackURL: "/",
  };
  const result = await auth.api.signUpEmail({
    body: body as { email: string; password: string; name: string; callbackURL?: string },
  });
  return { user: result.user as { id: string; username: string } };
}
