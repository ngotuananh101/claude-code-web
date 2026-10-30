import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  CommandOutbox,
  issueRunnerCredential,
  migrate,
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
 * The workspace session-history surface over HTTP (§23 Task 8).
 *
 * `GET /api/workspaces/:workspaceId/sessions` forwards
 * `workspace.sessions.list` to a ready runner and answers with its
 * `rpc.result`. `GET /api/workspaces/:workspaceId/sessions/:sessionId/messages`
 * forwards `workspace.sessions.messages`.
 *
 * The `:workspaceId` is the composite `runnerId/workspaceId`, URL-encoded,
 * parsed by `parseCompositeId`. Auth mirrors every other browser route.
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

async function connectSessionsRunner(
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

const composite = encodeURIComponent("runner-a/default");

const sessionsListFrame = (commandId: string): RpcResultFrame => ({
  type: "rpc.result",
  commandId,
  ok: true,
  result: {
    op: "sessions.list",
    dir: "/srv/proj",
    sessions: [
      {
        sessionId: "sess-1",
        summary: "a session",
        lastModified: 1234567890,
        gitBranch: "main",
        cwd: "/srv/proj",
        createdAt: 1234567000,
      },
    ],
  },
});

const sessionMessagesFrame = (commandId: string): RpcResultFrame => ({
  type: "rpc.result",
  commandId,
  ok: true,
  result: {
    op: "sessions.messages",
    sessionId: "sess-1",
    messages: [
      { type: "user", uuid: "msg-1", message: { content: "hello" } },
      { type: "assistant", uuid: "msg-2", message: { content: "hi back" } },
    ],
  },
});

describe("GET /api/workspaces/:workspaceId/sessions", () => {
  test("lists sessions through the runner and returns the result", async () => {
    const { db, url, cookie, credential } = await start();
    db.query(
      "INSERT INTO workspaces (runner_id, workspace_id, path, branches, registered_at) VALUES (?, ?, ?, ?, ?)",
    ).run("runner-a", "default", "/srv/proj", "[]", Date.now());
    const inbox = runnerInbox();
    await connectSessionsRunner(url, credential, inbox, {
      answer: (command) => sessionsListFrame(command["commandId"] as string),
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/workspaces/${composite}/sessions`, {
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      op: "sessions.list",
      dir: "/srv/proj",
      sessions: [
        {
          sessionId: "sess-1",
          summary: "a session",
          lastModified: 1234567890,
          gitBranch: "main",
          cwd: "/srv/proj",
          createdAt: 1234567000,
        },
      ],
    });
  });

  test("forwards a limit query parameter to the runner", async () => {
    const { db, url, cookie, credential } = await start();
    db.query(
      "INSERT INTO workspaces (runner_id, workspace_id, path, branches, registered_at) VALUES (?, ?, ?, ?, ?)",
    ).run("runner-a", "default", "/srv/proj", "[]", Date.now());
    const inbox = runnerInbox();
    const { received } = await connectSessionsRunner(url, credential, inbox, {
      answer: (command) => sessionsListFrame(command["commandId"] as string),
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/workspaces/${composite}/sessions?limit=20`, {
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(received[0]).toMatchObject({
      kind: "workspace.sessions.list",
      runnerId: "runner-a",
      workspaceId: "default",
      payload: { op: "sessions.list", dir: "/srv/proj", limit: 20 },
    });
  });

  test("401 without a cookie, 403 from a foreign origin", async () => {
    const { db, url, cookie, credential } = await start();
    db.query(
      "INSERT INTO workspaces (runner_id, workspace_id, path, branches, registered_at) VALUES (?, ?, ?, ?, ?)",
    ).run("runner-a", "default", "/srv/proj", "[]", Date.now());
    await connectSessionsRunner(url, credential, runnerInbox());

    expect(
      (await fetch(`${url}/api/workspaces/${composite}/sessions`, { headers: { Origin: origin } }))
        .status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}/api/workspaces/${composite}/sessions`, {
          headers: { Origin: "https://evil.example.test", Cookie: cookie },
        })
      ).status,
    ).toBe(403);
  });

  test("404 for a workspace the owner does not own", async () => {
    const { url, cookie, credential } = await start();
    await connectSessionsRunner(url, credential, runnerInbox(), { workspaces: [] });

    const response = await fetch(`${url}/api/workspaces/${composite}/sessions`, {
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: "WORKSPACE_NOT_FOUND" }) }),
    );
  });

  test("400 for a malformed composite id", async () => {
    const { url, cookie } = await start();

    const response = await fetch(`${url}/api/workspaces/runner-only/sessions`, {
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(400);
  });

  test("503 when the runner is offline", async () => {
    const { db, url, cookie } = await start();
    db.query(
      "INSERT INTO workspaces (runner_id, workspace_id, path, branches, registered_at) VALUES (?, ?, ?, ?, ?)",
    ).run("runner-a", "default", "/srv/proj", "[]", Date.now());

    const response = await fetch(`${url}/api/workspaces/${composite}/sessions`, {
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: "RUNNER_UNAVAILABLE" }) }),
    );
  });

  test("503 when the runner lacks the sessions capability", async () => {
    const { db, url, cookie, credential } = await start();
    db.query(
      "INSERT INTO workspaces (runner_id, workspace_id, path, branches, registered_at) VALUES (?, ?, ?, ?, ?)",
    ).run("runner-a", "default", "/srv/proj", "[]", Date.now());
    await connectSessionsRunner(url, credential, runnerInbox(), { capabilities: ["inspect"] });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/workspaces/${composite}/sessions`, {
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: "RUNNER_UNAVAILABLE" }) }),
    );
  });
});

describe("GET /api/workspaces/:workspaceId/sessions/:sessionId/messages", () => {
  test("reads session messages through the runner and returns the result", async () => {
    const { db, url, cookie, credential } = await start();
    db.query(
      "INSERT INTO workspaces (runner_id, workspace_id, path, branches, registered_at) VALUES (?, ?, ?, ?, ?)",
    ).run("runner-a", "default", "/srv/proj", "[]", Date.now());
    const inbox = runnerInbox();
    await connectSessionsRunner(url, credential, inbox, {
      answer: (command) => sessionMessagesFrame(command["commandId"] as string),
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/workspaces/${composite}/sessions/sess-1/messages`, {
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      op: "sessions.messages",
      sessionId: "sess-1",
      messages: [
        { type: "user", uuid: "msg-1", message: { content: "hello" } },
        { type: "assistant", uuid: "msg-2", message: { content: "hi back" } },
      ],
    });
  });

  test("forwards a limit query parameter to the runner", async () => {
    const { db, url, cookie, credential } = await start();
    db.query(
      "INSERT INTO workspaces (runner_id, workspace_id, path, branches, registered_at) VALUES (?, ?, ?, ?, ?)",
    ).run("runner-a", "default", "/srv/proj", "[]", Date.now());
    const inbox = runnerInbox();
    const { received } = await connectSessionsRunner(url, credential, inbox, {
      answer: (command) => sessionMessagesFrame(command["commandId"] as string),
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(
      `${url}/api/workspaces/${composite}/sessions/sess-1/messages?limit=50`,
      { headers: { Origin: origin, Cookie: cookie } },
    );

    expect(response.status).toBe(200);
    expect(received[0]).toMatchObject({
      kind: "workspace.sessions.messages",
      runnerId: "runner-a",
      workspaceId: "default",
      payload: { op: "sessions.messages", sessionId: "sess-1", limit: 50 },
    });
  });

  test("401 without a cookie, 403 from a foreign origin", async () => {
    const { db, url, cookie, credential } = await start();
    db.query(
      "INSERT INTO workspaces (runner_id, workspace_id, path, branches, registered_at) VALUES (?, ?, ?, ?, ?)",
    ).run("runner-a", "default", "/srv/proj", "[]", Date.now());
    await connectSessionsRunner(url, credential, runnerInbox());

    expect(
      (
        await fetch(`${url}/api/workspaces/${composite}/sessions/sess-1/messages`, {
          headers: { Origin: origin },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}/api/workspaces/${composite}/sessions/sess-1/messages`, {
          headers: { Origin: "https://evil.example.test", Cookie: cookie },
        })
      ).status,
    ).toBe(403);
  });

  test("404 for a workspace the owner does not own", async () => {
    const { url, cookie, credential } = await start();
    await connectSessionsRunner(url, credential, runnerInbox(), { workspaces: [] });

    const response = await fetch(`${url}/api/workspaces/${composite}/sessions/sess-1/messages`, {
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(404);
  });

  test("503 when the runner is offline", async () => {
    const { db, url, cookie } = await start();
    db.query(
      "INSERT INTO workspaces (runner_id, workspace_id, path, branches, registered_at) VALUES (?, ?, ?, ?, ?)",
    ).run("runner-a", "default", "/srv/proj", "[]", Date.now());

    const response = await fetch(`${url}/api/workspaces/${composite}/sessions/sess-1/messages`, {
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(503);
  });
});

describe("session rename and delete routes", () => {
  test("PATCH /api/sessions/:id renames the session", async () => {
    const { db, url, cookie } = await start();
    db.query(
      "INSERT INTO sessions (id, owner_id, workspace_id, runner_id, created_at) VALUES ('sess-123', 'user-1', 'default', 'runner-a', ?)",
    ).run(Date.now());

    const response = await fetch(`${url}/api/sessions/sess-123`, {
      method: "PATCH",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Tên phiên mới" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      sessionId: "sess-123",
      title: "Tên phiên mới",
    });

    const row = db.query("SELECT title FROM sessions WHERE id = 'sess-123'").get() as {
      title: string;
    };
    expect(row.title).toBe("Tên phiên mới");
  });

  test("PATCH /api/sessions/:id returns 404 for unknown session", async () => {
    const { url, cookie } = await start();
    const response = await fetch(`${url}/api/sessions/unknown`, {
      method: "PATCH",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test" }),
    });
    expect(response.status).toBe(404);
  });

  test("DELETE /api/sessions/:id deletes the session", async () => {
    const { db, url, cookie } = await start();
    db.query(
      "INSERT INTO sessions (id, owner_id, workspace_id, runner_id, created_at) VALUES ('sess-del', 'user-1', 'default', 'runner-a', ?)",
    ).run(Date.now());

    const response = await fetch(`${url}/api/sessions/sess-del`, {
      method: "DELETE",
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, sessionId: "sess-del" });

    const row = db.query("SELECT id FROM sessions WHERE id = 'sess-del'").get();
    expect(row).toBeNull();
  });

  test("DELETE /api/sessions/:id returns 404 for unknown session", async () => {
    const { url, cookie } = await start();
    const response = await fetch(`${url}/api/sessions/unknown`, {
      method: "DELETE",
      headers: { Origin: origin, Cookie: cookie },
    });
    expect(response.status).toBe(404);
  });
});
