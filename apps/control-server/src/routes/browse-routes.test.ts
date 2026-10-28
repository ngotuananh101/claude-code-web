import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  CommandOutbox,
  issueRunnerCredential,
  migrate,
  upsertRunnerWorkspaces,
  verifyRunnerCredential,
} from "@cc-web/control-db";
import type { RpcResultFrame } from "@cc-web/protocol";
import { acceptCommand, migrateRunnerDb } from "@cc-web/runner-db";
import type { Link } from "../../../runner/src/connection/reconnect-loop.ts";
import { dialWebSocket } from "../../../runner/src/connection/websocket-link.ts";
import { asCommandEnvelope } from "../../../runner/src/execution/envelope.ts";
import { AuthService } from "../auth/auth-service.ts";
import { createSigner } from "../auth/tokens.ts";
import { createServer, type ServerHandle } from "../server.ts";

/**
 * The browse and workspace-registration surface over HTTP.
 *
 * `GET /api/runners/:runnerId/browse?path=...` forwards `workspace.fs.browse`
 * to a ready runner and answers with its `rpc.result`. `POST
 * /api/runners/:runnerId/workspaces` registers a custom path in the control
 * plane's `workspaces` table so the owner can address it through a stable
 * composite id.
 *
 * Auth mirrors every other browser route: Origin allowlist, then the session
 * cookie, `no-store` because the answers are identity-bearing (§19.4).
 */

const origin = "https://cc.example.test";

let handle: ServerHandle | undefined;
const links: Link[] = [];

afterEach(() => {
  for (const link of links.splice(0)) {
    try {
      link.close();
    } catch {
      // A closed socket is already the state the sweep wants.
    }
  }
  handle?.stop();
  handle = undefined;
});

async function start() {
  const db = new Database(":memory:");
  migrate(db);

  db.query(
    "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("user-1", "owner", "hash", 1, Date.now());
  const { credential } = issueRunnerCredential(db, { id: "runner-a", ownerId: "user-1" });

  const auth = new AuthService({ db, signer: createSigner(new Uint8Array(32).fill(11)) });
  handle = createServer({
    db,
    auth,
    allowedOrigins: [origin],
    verifyRunnerCredential: (candidate) => verifyRunnerCredential(db, candidate),
    outbox: new CommandOutbox(db),
  });
  const cookie = `cc_session=${await auth.issueAccessToken("user-1")}`;
  return { db, url: `http://127.0.0.1:${handle.server.port}`, cookie, credential };
}

/**
 * A runner that completes the handshake and answers commands with canned
 * frames. The `answer` callback produces the `rpc.result` for each command the
 * server sends; tests that want silence return nothing and leave the HTTP
 * waiter hanging.
 */
async function connectBrowseRunner(
  url: string,
  credential: string,
  inbox: Database,
  options: {
    capabilities?: string[];
    workspaces?: Array<{ workspaceId: string; path: string }>;
    answer?: (command: Record<string, unknown>) => RpcResultFrame | undefined;
  } = {},
) {
  const received: Array<Record<string, unknown>> = [];
  const link = await dialWebSocket({
    url: `${url.replace("http", "ws")}/ws/runner`,
    credential,
  });
  links.push(link);

  const opened = new Promise<void>((resolve) => {
    link.onMessage((raw) => {
      const frame = JSON.parse(raw) as Record<string, unknown>;
      if (frame["type"] === "hello.ok") {
        link.send(
          JSON.stringify({
            type: "reconcile",
            runner: [],
            workspaces: options.workspaces ?? [{ workspaceId: "default", path: "/srv/proj" }],
          }),
        );
      }
      if (frame["type"] === "reconcile.ok") resolve();

      if (frame["type"] === "command") {
        const record = frame["command"] as Record<string, unknown>;
        received.push(record);
        const parsed = asCommandEnvelope(record);
        if (parsed === undefined) {
          link.send(
            JSON.stringify({
              type: "command.receipt",
              commandId: record["commandId"],
              attemptId: "",
              accepted: false,
              reason: "malformed",
            }),
          );
          return;
        }
        const result = acceptCommand(inbox, parsed, { localRunnerId: "runner-a" });
        link.send(
          JSON.stringify({
            type: "command.receipt",
            commandId: record["commandId"],
            attemptId: record["attemptId"] ?? "",
            accepted: result.ok,
          }),
        );
        const resultFrame = options.answer?.(record);
        if (resultFrame !== undefined) link.send(JSON.stringify(resultFrame));
      }
    });
  });

  link.send(
    JSON.stringify({
      type: "hello",
      hello: {
        protocolVersion: 1,
        runnerId: "runner-a",
        bootId: "boot-runner-a",
        runnerVersion: "0.0.0",
        sdkVersion: "0.3.309",
        platform: "linux/x64",
        maxConcurrentRuns: 1,
        activeRuns: [],
        eventOffsets: [],
        capabilities: options.capabilities ?? ["workspace.browse", "workspace.sessions", "inspect"],
        workspaces: options.workspaces ?? [{ workspaceId: "default", path: "/srv/proj" }],
      },
    }),
  );

  await opened;
  return { received };
}

function runnerInbox() {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  return db;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

const browseFrame = (commandId: string): RpcResultFrame => ({
  type: "rpc.result",
  commandId,
  ok: true,
  result: {
    op: "fs.browse",
    currentPath: "/srv/proj",
    parentPath: "/",
    shortcuts: [{ label: "~", path: "/root" }],
    entries: [
      {
        name: "README.md",
        path: "README.md",
        isDir: false,
        isGitRepo: false,
        hasClaudeProject: false,
      },
    ],
    truncated: false,
  },
});

describe("GET /api/runners/:runnerId/browse", () => {
  test("browses a directory through the runner and returns its listing", async () => {
    const { db, url, cookie, credential } = await start();
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    const inbox = runnerInbox();
    await connectBrowseRunner(url, credential, inbox, {
      answer: (command) => browseFrame(command["commandId"] as string),
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/runners/runner-a/browse?path=`, {
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      op: "fs.browse",
      currentPath: "/srv/proj",
      parentPath: "/",
      shortcuts: [{ label: "~", path: "/root" }],
      entries: [
        {
          name: "README.md",
          path: "README.md",
          isDir: false,
          isGitRepo: false,
          hasClaudeProject: false,
        },
      ],
      truncated: false,
    });
  });

  test("forwards the requested path in the browse payload", async () => {
    const { db, url, cookie, credential } = await start();
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    const inbox = runnerInbox();
    const { received } = await connectBrowseRunner(url, credential, inbox, {
      answer: (command) => browseFrame(command["commandId"] as string),
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/runners/runner-a/browse?path=src`, {
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(received[0]).toMatchObject({
      kind: "workspace.fs.browse",
      runnerId: "runner-a",
      payload: { path: "src" },
    });
  });

  test("401 without a cookie, 403 from a foreign origin", async () => {
    const { db, url, cookie, credential } = await start();
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    await connectBrowseRunner(url, credential, runnerInbox());
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    expect(
      (await fetch(`${url}/api/runners/runner-a/browse`, { headers: { Origin: origin } })).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}/api/runners/runner-a/browse`, {
          headers: { Origin: "https://evil.example.test", Cookie: cookie },
        })
      ).status,
    ).toBe(403);
  });

  test("404 when the runner does not belong to the owner", async () => {
    const { url, cookie, credential } = await start();
    await connectBrowseRunner(url, credential, runnerInbox());

    const response = await fetch(`${url}/api/runners/runner-unknown/browse?path=`, {
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(404);
  });

  test("503 when the runner is offline", async () => {
    const { db, url, cookie } = await start();
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);

    const response = await fetch(`${url}/api/runners/runner-a/browse?path=`, {
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: "RUNNER_UNAVAILABLE" }) }),
    );
  });

  test("503 when the runner lacks the browse capability", async () => {
    const { db, url, cookie, credential } = await start();
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    await connectBrowseRunner(url, credential, runnerInbox(), { capabilities: [] });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/runners/runner-a/browse?path=`, {
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: "RUNNER_UNAVAILABLE" }) }),
    );
  });
});

describe("POST /api/runners/:runnerId/workspaces", () => {
  test("registers a custom path and returns 201 with the workspace id", async () => {
    const { db, url, cookie } = await start();

    const response = await fetch(`${url}/api/runners/runner-a/workspaces`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/home/user/projects/custom" }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { workspaceId: string; path: string; runnerId: string };
    expect(body.runnerId).toBe("runner-a");
    expect(body.path).toBe("/home/user/projects/custom");
    expect(body.workspaceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // The row is visible through the workspaces table.
    const workspace = db.query("SELECT * FROM workspaces WHERE runner_id = 'runner-a'").get() as {
      workspace_id: string;
      path: string;
    };
    expect(workspace.workspace_id).toBe(body.workspaceId);
    expect(workspace.path).toBe("/home/user/projects/custom");
  });

  test("uses a client-supplied workspaceId when provided", async () => {
    const { db, url, cookie } = await start();

    const response = await fetch(`${url}/api/runners/runner-a/workspaces`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/srv/custom", workspaceId: "my-ws" }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { workspaceId: string; path: string; runnerId: string };
    expect(body.workspaceId).toBe("my-ws");
    expect(body.path).toBe("/srv/custom");

    const workspace = db
      .query("SELECT * FROM workspaces WHERE runner_id = 'runner-a' AND workspace_id = 'my-ws'")
      .get() as { workspace_id: string; path: string } | null;
    expect(workspace).not.toBeNull();
    expect(workspace!.path).toBe("/srv/custom");
  });

  test("400 when the path is missing or empty", async () => {
    const { url, cookie } = await start();

    const empty = await fetch(`${url}/api/runners/runner-a/workspaces`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "" }),
    });
    expect(empty.status).toBe(400);

    const missing = await fetch(`${url}/api/runners/runner-a/workspaces`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
  });

  test("400 when the body is not a JSON object", async () => {
    const { url, cookie } = await start();

    const notAnObject = await fetch(`${url}/api/runners/runner-a/workspaces`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify("just a string"),
    });
    expect(notAnObject.status).toBe(400);
  });

  test("401 without a cookie, 403 from a foreign origin", async () => {
    const { url, cookie } = await start();

    expect(
      (
        await fetch(`${url}/api/runners/runner-a/workspaces`, {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify({ path: "/srv/custom" }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}/api/runners/runner-a/workspaces`, {
          method: "POST",
          headers: {
            Origin: "https://evil.example.test",
            Cookie: cookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ path: "/srv/custom" }),
        })
      ).status,
    ).toBe(403);
  });

  test("404 when the runner does not belong to the owner", async () => {
    const { url, cookie } = await start();

    const response = await fetch(`${url}/api/runners/runner-unknown/workspaces`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/srv/custom" }),
    });

    expect(response.status).toBe(404);
  });
});
