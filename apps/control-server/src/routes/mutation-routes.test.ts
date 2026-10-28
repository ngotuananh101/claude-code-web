import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CommandOutbox,
  issueRunnerCredential,
  migrate,
  upsertRunnerWorkspaces,
  verifyRunnerCredential,
} from "@cc-web/control-db";
import type { RpcResultFrame } from "@cc-web/protocol";
import { acceptCommand, migrateRunnerDb } from "@cc-web/runner-db";
import type { Link } from "../../../runner/src/connection/reconnect-loop";
import { dialWebSocket } from "../../../runner/src/connection/websocket-link";
import { asCommandEnvelope } from "../../../runner/src/execution/envelope";
import { AuthService } from "../auth/auth-service";
import { createSigner } from "../auth/tokens";
import { createServer, type ServerHandle } from "../server";

const origin = "https://cc.example.test";

let handle: ServerHandle | undefined;
let links: Link[] = [];

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

beforeEach(() => {
  links = [];
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
 * A runner that completes the handshake and answers mutation commands with
 * canned frames. The `answer` callback produces the `rpc.result` for each
 * command the server sends; tests that want silence return nothing and leave
 * the HTTP waiter hanging.
 */
async function connectRunner(
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
        // Mutations need a receipt.
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
        capabilities: options.capabilities ?? ["inspect", "workspace.write"],
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

const fileWriteFrame = (commandId: string): RpcResultFrame => ({
  type: "rpc.result",
  commandId,
  ok: true,
  result: {
    op: "file.write",
    path: "a.txt",
    hash: "new",
    size: 5,
  },
});

const fileRevertFrame = (commandId: string): RpcResultFrame => ({
  type: "rpc.result",
  commandId,
  ok: true,
  result: {
    op: "file.revert",
    path: "a.txt",
    action: "restored",
    hash: "base",
    size: 3,
  },
});

const snapshotStatusFrame = (commandId: string): RpcResultFrame => ({
  type: "rpc.result",
  commandId,
  ok: true,
  result: {
    op: "snapshot.status",
    baseline: null,
    entries: [],
    counts: { modified: 0, created: 0, deleted: 0, excluded: 0 },
    digest: null,
    truncated: false,
  },
});

describe("mutation routes", () => {
  test("PUT file saves through the runner and returns the new hash", async () => {
    const { db, url, cookie, credential } = await start();
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    const inbox = runnerInbox();
    const { received } = await connectRunner(url, credential, inbox, {
      answer: (command) => fileWriteFrame(command["commandId"] as string),
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/workspaces/${composite}/file?path=a.txt`, {
      method: "PUT",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "next\n", expectedHash: "prev" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      op: "file.write",
      path: "a.txt",
      hash: "new",
      size: 5,
    });
    expect(received[0]).toMatchObject({
      kind: "workspace.file.write",
      workspaceId: "default",
      payload: { op: "file.write", path: "a.txt", content: "next\n", expectedHash: "prev" },
    });
  });

  test("a stale token maps FILE_CONFLICT to 409 and is not retryable", async () => {
    const { db, url, cookie, credential } = await start();
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    await connectRunner(url, credential, runnerInbox(), {
      answer: (command) => ({
        type: "rpc.result",
        commandId: command["commandId"] as string,
        ok: false,
        error: { code: "FILE_CONFLICT", message: "hash mismatch" },
      }),
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/workspaces/${composite}/file?path=a.txt`, {
      method: "PUT",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "next\n", expectedHash: "prev" }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; retryable: boolean } };
    expect(body.error).toEqual(
      expect.objectContaining({ code: "FILE_CONFLICT", retryable: false }),
    );
  });

  test("a runner without workspace.write is refused before enqueue", async () => {
    const { db, url, cookie, credential } = await start();
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    const { received } = await connectRunner(url, credential, runnerInbox(), {
      capabilities: ["inspect"],
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/workspaces/${composite}/file?path=a.txt`, {
      method: "PUT",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "next\n", expectedHash: "prev" }),
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RUNNER_UNAVAILABLE");
    expect(received).toHaveLength(0);
  });

  test("a malformed body is a 400 and a >2 MiB body a 413", async () => {
    const { db, url, cookie, credential } = await start();
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    await connectRunner(url, credential, runnerInbox());
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const bad = await fetch(`${url}/api/workspaces/${composite}/file?path=a.txt`, {
      method: "PUT",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(bad.status).toBe(400);

    const big = await fetch(`${url}/api/workspaces/${composite}/file?path=a.txt`, {
      method: "PUT",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x".repeat(2 * 1024 * 1024 + 1), expectedHash: "prev" }),
    });
    expect(big.status).toBe(413);
  });

  test("POST file/revert carries path and expectedHash", async () => {
    const { db, url, cookie, credential } = await start();
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    const inbox = runnerInbox();
    const { received } = await connectRunner(url, credential, inbox, {
      answer: (command) => fileRevertFrame(command["commandId"] as string),
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/workspaces/${composite}/file/revert`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "a.txt", expectedHash: null }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      op: "file.revert",
      path: "a.txt",
      action: "restored",
      hash: "base",
      size: 3,
    });
    expect(received[0]).toMatchObject({
      kind: "workspace.file.revert",
      workspaceId: "default",
      payload: { op: "file.revert", path: "a.txt", expectedHash: null },
    });
  });

  test("POST revert maps REVERT_STALE to 409", async () => {
    const { db, url, cookie, credential } = await start();
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    const { received } = await connectRunner(url, credential, runnerInbox(), {
      answer: (command) => ({
        type: "rpc.result",
        commandId: command["commandId"] as string,
        ok: false,
        error: { code: "REVERT_STALE", message: "digest changed" },
      }),
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/workspaces/${composite}/revert`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ planDigest: "d1" }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REVERT_STALE");
    expect(received[0]).toMatchObject({
      kind: "workspace.revert",
      workspaceId: "default",
      payload: { op: "workspace.revert", planDigest: "d1" },
    });
  });

  test("GET snapshot answers the baseline status without a body", async () => {
    const { db, url, cookie, credential } = await start();
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/proj" }]);
    const { received } = await connectRunner(url, credential, runnerInbox(), {
      answer: (command) => snapshotStatusFrame(command["commandId"] as string),
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/workspaces/${composite}/snapshot`, {
      method: "GET",
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      op: "snapshot.status",
      baseline: null,
      entries: [],
      counts: { modified: 0, created: 0, deleted: 0, excluded: 0 },
      digest: null,
      truncated: false,
    });
    expect(received[0]).toMatchObject({
      kind: "workspace.inspect",
      workspaceId: "default",
      payload: { op: "snapshot.status" },
    });
  });
});
