import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { migrate, upsertRunnerWorkspaces } from "@cc-web/control-db";
import { AuthService } from "../auth/auth-service.ts";
import { createSigner } from "../auth/tokens.ts";
import { createServer, type ServerHandle } from "../server.ts";

/**
 * The owner's workspace list over HTTP (§16.1, §17.1): the composer's project
 * select reads this. The runner is the registration authority, so a workspace
 * here is one a connected runner declared — the list answers nothing about
 * topology the runner did not vouch for.
 *
 * Auth mirrors every other browser route: Origin allowlist, then the session
 * cookie, `no-store` because the answer is identity-bearing (§19.4).
 */

const origin = "https://cc.example.test";

let handle: ServerHandle | undefined;

async function start() {
  const db = new Database(":memory:");
  migrate(db);

  db.query(
    "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("user-1", "owner", "hash", 1, Date.now());

  const auth = new AuthService({ db, signer: createSigner(new Uint8Array(32).fill(11)) });
  handle = createServer({
    db,
    auth,
    allowedOrigins: [origin],
    verifyRunnerCredential: () => ({ ok: false, reason: "unknown" }),
  });

  const cookie = `cc_session=${await auth.issueAccessToken("user-1")}`;

  return {
    db,
    url: `http://127.0.0.1:${handle.server.port}`,
    cookie,
  };
}

function seedRunner(
  db: Database,
  runnerId: string,
  opts: { ownerId?: string; revoked?: boolean; createdAt?: number } = {},
): void {
  db.query("INSERT INTO runners (id, owner_id, created_at, revoked_at) VALUES (?, ?, ?, ?)").run(
    runnerId,
    opts.ownerId ?? "user-1",
    opts.createdAt ?? 1,
    opts.revoked === true ? 2 : null,
  );
}

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

describe("GET /api/workspaces", () => {
  test("answers the owner's workspaces with runner and path, no-store", async () => {
    const { db, url, cookie } = await start();
    seedRunner(db, "runner-a");
    seedRunner(db, "runner-b", { createdAt: 2 });
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    upsertRunnerWorkspaces(db, "runner-b", [
      { workspaceId: "w-2", path: "/srv/other", branches: ["dev"] },
    ]);

    const response = await fetch(`${url}/api/workspaces`, {
      headers: { origin, cookie },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      workspaces: Array<{
        workspaceId: string;
        runnerId: string;
        path: string;
        branches: string[];
        createdAt: number;
      }>;
    };
    expect(body.workspaces).toEqual([
      {
        workspaceId: "default",
        runnerId: "runner-a",
        path: "/srv/proj",
        branches: [],
        createdAt: 1,
      },
      {
        workspaceId: "w-2",
        runnerId: "runner-b",
        path: "/srv/other",
        branches: ["dev"],
        createdAt: 2,
      },
    ]);
  });

  test("a revoked runner's workspaces never appear", async () => {
    const { db, url, cookie } = await start();
    seedRunner(db, "runner-a", { revoked: true });
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);

    const response = await fetch(`${url}/api/workspaces`, {
      headers: { origin, cookie },
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as { workspaces: unknown[] }).toEqual({ workspaces: [] });
  });

  test("a foreign origin is refused before the cookie is read", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/api/workspaces`, {
      headers: { origin: "https://evil.example", cookie: "cc_session=bogus" },
    });

    expect(response.status).toBe(403);
  });

  test("an unauthenticated call is refused", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/api/workspaces`, {
      headers: { origin },
    });

    expect(response.status).toBe(401);
  });
});
