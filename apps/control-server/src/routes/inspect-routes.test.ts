import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  CommandOutbox,
  issueRunnerCredential,
  migrate,
  upsertRunnerWorkspaces,
  verifyRunnerCredential,
  workspacesForOwner,
} from "@cc-web/control-db";
import type { RpcResultFrame } from "@cc-web/protocol";
import { acceptCommand, migrateRunnerDb } from "@cc-web/runner-db";
import type { Link } from "../../../runner/src/connection/reconnect-loop.ts";
import { dialWebSocket } from "../../../runner/src/connection/websocket-link.ts";
import { asCommandEnvelope } from "../../../runner/src/execution/envelope.ts";
import { AuthService } from "../auth/auth-service.ts";
import { createSigner } from "../auth/tokens.ts";
import { createServer, type ServerHandle } from "../server.ts";
import { parseCompositeId } from "./inspect-routes.ts";

/**
 * The read-only inspection surface over HTTP (§23 §10).
 *
 * Five routes, one shared contract: the owner asks about a workspace through
 * its composite id, the server forwards a bounded `workspace.inspect` /
 * `config.inspect` command to the ready runner, and the runner's `rpc.result`
 * answers the waiting HTTP request. Every assertion here is domain-shaped:
 * 401/403 stay plain text like every existing route, domain failures are
 * JSON ApiErrors, and the answer is never cached.
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
 * A runner that completes the handshake and answers inspection commands with
 * canned frames. The `answer` callback produces the `rpc.result` for each
 * command the server sends; tests that want silence return nothing and leave
 * the HTTP waiter hanging.
 */
async function connectInspectRunner(
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
        // Inspections are one-way: the receipt is owed, and the result answers
        // the waiter separately (T6's CommandOutcome split).
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
        capabilities: options.capabilities ?? ["inspect"],
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

const fileListFrame = (commandId: string): RpcResultFrame => ({
  type: "rpc.result",
  commandId,
  ok: true,
  result: {
    op: "file.list",
    path: "",
    entries: [{ name: "README.md", kind: "file", size: 12 }],
    truncated: false,
  },
});

describe("GET /api/workspaces/:id/files", () => {
  test("reads a directory through the runner and returns its listing", async () => {
    const { db, url, cookie, credential } = await start();
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    const inbox = runnerInbox();
    await connectInspectRunner(url, credential, inbox, {
      answer: (command) => fileListFrame(command["commandId"] as string),
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/workspaces/${composite}/files?path=`, {
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      op: "file.list",
      path: "",
      entries: [{ name: "README.md", kind: "file", size: 12 }],
      truncated: false,
    });
  });

  test("401 without a cookie, 403 from a foreign origin", async () => {
    const { db, url, cookie, credential } = await start();
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    await connectInspectRunner(url, credential, runnerInbox());

    expect(
      (await fetch(`${url}/api/workspaces/${composite}/files`, { headers: { Origin: origin } }))
        .status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}/api/workspaces/${composite}/files`, {
          headers: { Origin: "https://evil.example.test", Cookie: cookie },
        })
      ).status,
    ).toBe(403);
  });

  test("404 for a workspace the owner does not own", async () => {
    const { url, cookie, credential } = await start();
    // The runner declares nothing, so the composite id names no workspace this
    // owner holds.
    await connectInspectRunner(url, credential, runnerInbox(), { workspaces: [] });

    const response = await fetch(`${url}/api/workspaces/${composite}/files`, {
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(404);
    // §17.3's ApiError: the code lives under `error`, so the web service
    // (T11) parses one shape for every domain failure.
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: "WORKSPACE_NOT_FOUND" }) }),
    );
  });

  test("400 for a malformed composite id", async () => {
    const { url, cookie } = await start();

    const response = await fetch(`${url}/api/workspaces/runner-only/files`, {
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("503 promptly when the runner is offline", async () => {
    const { db, url, cookie } = await start();
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    // No runner connected at all.

    const started = Date.now();
    const response = await fetch(`${url}/api/workspaces/${composite}/files`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    const elapsed = Date.now() - started;

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: "RUNNER_UNAVAILABLE" }) }),
    );
    // Answered without waiting the timeout: this is the pre-enqueue fast path.
    expect(elapsed).toBeLessThan(5000);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("503 when the runner does not declare the inspect capability", async () => {
    const { db, url, cookie, credential } = await start();
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    await connectInspectRunner(url, credential, runnerInbox(), { capabilities: [] });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/workspaces/${composite}/files`, {
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: "RUNNER_UNAVAILABLE" }) }),
    );
  });

  test(
    "503 RUNNER_UNAVAILABLE when the runner never answers",
    async () => {
      const { db, url, cookie, credential } = await start();
      upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
      // The runner takes the command and stays silent; the waiter is the backstop.
      await connectInspectRunner(url, credential, runnerInbox());
      await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

      const response = await fetch(`${url}/api/workspaces/${composite}/files`, {
        headers: { Origin: origin, Cookie: cookie },
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(
        expect.objectContaining({ error: expect.objectContaining({ code: "RUNNER_UNAVAILABLE" }) }),
      );
    },
    { timeout: 15000 },
  );

  test("a refused inspection returns its code and a no-store header", async () => {
    const { db, url, cookie, credential } = await start();
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    await connectInspectRunner(url, credential, runnerInbox(), {
      answer: (command) => ({
        type: "rpc.result",
        commandId: command["commandId"] as string,
        ok: false,
        error: { code: "PATH_OUTSIDE_WORKSPACE", message: "outside" },
      }),
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/workspaces/${composite}/files?path=../x`, {
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "PATH_OUTSIDE_WORKSPACE" }),
      }),
    );
  });

  test("a 502 refusal is not advertised as retryable", async () => {
    const { db, url, cookie, credential } = await start();
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    // NOT_A_FILE is a client-shape refusal: retrying it changes nothing. The
    // flag must follow the code, not the 5xx class of its status (§17.3).
    await connectInspectRunner(url, credential, runnerInbox(), {
      answer: (command) => ({
        type: "rpc.result",
        commandId: command["commandId"] as string,
        ok: false,
        error: { code: "NOT_A_FILE", message: "path is not a regular file" },
      }),
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/workspaces/${composite}/file?path=src`, {
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "NOT_A_FILE", retryable: false }),
      }),
    );
  });

  test("the outbox row is retired when the runner answers", async () => {
    const { db, url, cookie, credential } = await start();
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    await connectInspectRunner(url, credential, runnerInbox(), {
      answer: (command) => fileListFrame(command["commandId"] as string),
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/workspaces/${composite}/files`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    expect(response.status).toBe(200);

    // Ruling 2: the result IS the answer, so it is the proof the command was
    // served. Left `sent`, the row would stay deliverable and later be retired
    // as "expired" — auditing a succeeded read as a failure.
    const row = db.query("SELECT * FROM command_outbox").get() as {
      delivery_state: string;
      attempt_id: string | null;
    };
    expect(row.delivery_state).toBe("accepted");
    // No attempt was invented for a read (§9.1: only work that starts a run
    // carries one).
    expect(row.attempt_id).toBeNull();
  });

  test(
    "the outbox row is retired when the timed-out request gives up",
    async () => {
      const { db, url, cookie, credential } = await start();
      upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
      await connectInspectRunner(url, credential, runnerInbox());
      await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

      const response = await fetch(`${url}/api/workspaces/${composite}/files`, {
        headers: { Origin: origin, Cookie: cookie },
      });
      expect(response.status).toBe(503);

      expect(workspacesForOwner(db, "user-1")).toHaveLength(1);
      const pendingRows = db
        .query("SELECT * FROM command_outbox WHERE delivery_state = 'pending'")
        .all();
      expect(pendingRows).toEqual([]);
    },
    { timeout: 15000 },
  );
});

describe("parseCompositeId", () => {
  test("splits on the first slash", () => {
    expect(parseCompositeId("r-1/ws-1")).toEqual({ runnerId: "r-1", workspaceId: "ws-1" });
  });

  test("rejects a missing or empty half", () => {
    expect(parseCompositeId("r-1")).toBeUndefined();
    expect(parseCompositeId("/ws")).toBeUndefined();
    expect(parseCompositeId("r-1/")).toBeUndefined();
  });

  test("URL-decodes each half after splitting", () => {
    expect(parseCompositeId(`${encodeURIComponent("r 1")}/${encodeURIComponent("ws")}`)).toEqual({
      runnerId: "r 1",
      workspaceId: "ws",
    });
  });

  test("rejects a workspace id that carries its own slash", () => {
    expect(parseCompositeId("r-1/ws/2")).toBeUndefined();
  });
});
