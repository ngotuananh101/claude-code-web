import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  CommandOutbox,
  issueRunnerCredential,
  migrate,
  verifyRunnerCredential,
} from "@cc-web/control-db";
import { acceptCommand, migrateRunnerDb } from "@cc-web/runner-db";
import type { Link } from "../../../runner/src/connection/reconnect-loop.ts";
import { dialWebSocket } from "../../../runner/src/connection/websocket-link.ts";
import { asCommandEnvelope } from "../../../runner/src/execution/envelope.ts";
import { AuthService } from "../auth/auth-service.ts";
import { createSigner } from "../auth/tokens.ts";
import { createServer, type ServerHandle } from "../server.ts";

/**
 * The browser's run surface over HTTP (§17.1): submit a prompt, cancel a run.
 *
 * The runner on the other side is the real handshake over a real socket, but a
 * thin one — the dispatch end-to-end tests already prove the loop; these tests
 * are about what the route does: auth, validation, runner selection, and the
 * status it answers with.
 */

const origin = "https://cc.example.test";

let handle: ServerHandle | undefined;
let link: Link | undefined;

afterEach(() => {
  link?.close();
  link = undefined;
  handle?.stop();
  handle = undefined;
});

async function start() {
  const db = new Database(":memory:");
  migrate(db);

  db.query(
    "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("user-1", "owner", "hash", 1, Date.now());
  // The credential also upserts the runner row, exactly like POST /api/runners.
  const { credential } = issueRunnerCredential(db, { id: "runner-a", ownerId: "user-1" });

  const auth = new AuthService({ db, signer: createSigner(new Uint8Array(32).fill(11)) });
  handle = createServer({
    db,
    auth,
    allowedOrigins: [origin],
    verifyRunnerCredential: (candidate) => verifyRunnerCredential(db, candidate),
    // The production wiring always passes an outbox: without one there is no
    // dispatcher, and this file is precisely about delivery to the runner.
    outbox: new CommandOutbox(db),
  });
  const cookie = `cc_session=${await auth.issueAccessToken("user-1")}`;
  return { db, url: `http://127.0.0.1:${handle.server.port}`, cookie, credential };
}

/**
 * A runner that completes the §6.2 handshake and answers commands from the real
 * inbox. Emits nothing on its own; the tests push events through `send`.
 */
async function connectRunner(url: string, credential: string, inbox: Database) {
  const received: Array<Record<string, unknown>> = [];

  link = await dialWebSocket({
    url: url.replace("http", "ws") + "/ws/runner",
    credential,
  });

  const opened = new Promise<void>((resolve) => {
    link!.onMessage((raw) => {
      const frame = JSON.parse(raw) as Record<string, unknown>;
      if (frame["type"] === "hello.ok") {
        link!.send(JSON.stringify({ type: "reconcile", runner: [] }));
      }
      if (frame["type"] === "reconcile.ok") resolve();

      if (frame["type"] === "command") {
        const record = frame["command"] as Record<string, unknown>;
        received.push(record);
        const parsed = asCommandEnvelope(record);
        const result =
          parsed === undefined
            ? { ok: false as const, reason: "malformed" }
            : acceptCommand(inbox, parsed, { localRunnerId: "runner-a" });
        link!.send(
          JSON.stringify({
            type: "command.receipt",
            commandId: record["commandId"],
            attemptId: record["attemptId"] ?? "",
            accepted: result.ok,
            ...("reason" in result ? { reason: result.reason } : {}),
          }),
        );
      }
    });
  });

  link.send(
    JSON.stringify({
      type: "hello",
      hello: {
        protocolVersion: 1,
        runnerId: "runner-a",
        bootId: "boot-1",
        runnerVersion: "0.0.0",
        sdkVersion: "0.3.309",
        platform: "linux/x64",
        maxConcurrentRuns: 1,
        activeRuns: [],
        eventOffsets: [],
      },
    }),
  );

  await opened;
  return {
    received,
    send: (frame: Record<string, unknown>) => link!.send(JSON.stringify(frame)),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

function runnerInbox() {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  return db;
}

async function dispatch(url: string, cookie: string, prompt: string, sessionId = "session-1") {
  return fetch(`${url}/api/sessions/${sessionId}/runs`, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
}

describe("POST /api/sessions/:id/runs", () => {
  test("a prompt to a session with a ready runner dispatches a run", async () => {
    const { db, url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await dispatch(url, cookie, "hello");

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      runId: string;
      attemptId: string;
      sessionId: string;
      runnerId: string;
    };
    expect(body.sessionId).toBe("session-1");
    expect(body.runnerId).toBe("runner-a");
    expect(body.runId).toBeTruthy();
    expect(body.attemptId).toBeTruthy();

    // The command reached the runner's inbox with the prompt intact.
    await waitFor(() => {
      const rows = inbox.query("SELECT payload FROM command_inbox").all() as { payload: string }[];
      return rows.some(
        (row) => (JSON.parse(row.payload) as { prompt?: string }).prompt === "hello",
      );
    });
    expect(
      db.query("SELECT COUNT(*) AS n FROM active_runs WHERE session_id = ?").get("session-1"),
    ).toEqual({ n: 1 });
  });

  test("a second dispatch on the same session is refused while a run is active", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const first = await dispatch(url, cookie, "hello");
    expect(first.status).toBe(202);

    const second = await dispatch(url, cookie, "again");

    expect(second.status).toBe(409);
    expect(await second.text()).toBe("session_busy");
  });

  test("a finished run releases the session for the next prompt", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    const runner = await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const first = (await (await dispatch(url, cookie, "hello")).json()) as { runId: string };

    // The runner reports the terminal event the way the real daemon would.
    runner.send({
      type: "events",
      events: [
        {
          protocolVersion: 1,
          eventId: "evt-1",
          runnerId: "runner-a",
          bootId: "boot-1",
          sessionId: "session-1",
          runId: first.runId,
          attemptId: "attempt-x",
          localSequence: 1,
          occurredAt: new Date().toISOString(),
          type: "run.finished",
          payload: {},
        },
      ],
    });
    await waitFor(() => handle!.scheduler.activeRunFor("session-1") === undefined);

    const again = await dispatch(url, cookie, "next");
    expect(again.status).toBe(202);
  });

  test("no ready runner answers 503 with the reason, not a queued promise", async () => {
    const { url, cookie } = await start();

    const response = await dispatch(url, cookie, "hello");

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("runner_offline");
  });

  test("a prompt that is not a non-empty string is a bad request", async () => {
    const { url, cookie } = await start();

    const response = await dispatch(url, cookie, "   ");

    expect(response.status).toBe(400);
  });

  test("a foreign Origin is refused before the cookie is read", async () => {
    const { url, cookie } = await start();

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: "https://evil.example.test", Cookie: cookie },
    });
    expect(response.status).toBe(403);
  });

  test("without a session cookie the answer is the one 401", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin },
    });
    expect(response.status).toBe(401);
  });
});

describe("the permission mode on POST /api/sessions/:id/runs", () => {
  test("a chosen mode travels in the run.start payload", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", permissionMode: "acceptEdits" }),
    });
    expect(response.status).toBe(202);

    await waitFor(() =>
      (inbox.query("SELECT payload FROM command_inbox").all() as Array<{ payload: string }>).some(
        (row) =>
          (JSON.parse(row.payload) as { prompt?: string }).prompt === "hello" &&
          (JSON.parse(row.payload) as { permissionMode?: string }).permissionMode === "acceptEdits",
      ),
    );
  });

  test("an unknown mode is a bad request, not a silent default", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", permissionMode: "yolo" }),
    });

    expect(response.status).toBe(400);
    expect((inbox.query("SELECT COUNT(*) AS n FROM command_inbox").get() as { n: number }).n).toBe(
      0,
    );
  });
});

describe("POST /api/runs/:id/cancel", () => {
  test("cancelling a dispatched run sends run.cancel to the holding runner", async () => {
    const { db, url, cookie, credential } = await start();
    const inbox = runnerInbox();
    const runner = await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const dispatched = (await (await dispatch(url, cookie, "hello")).json()) as { runId: string };

    const response = await fetch(`${url}/api/runs/${dispatched.runId}/cancel`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(202);
    await waitFor(() =>
      runner.received.some(
        (command) => command["kind"] === "run.cancel" && command["runId"] === dispatched.runId,
      ),
    );
    // The slot survives: release belongs to the terminal event, not the request.
    expect(
      db.query("SELECT COUNT(*) AS n FROM active_runs WHERE run_id = ?").get(dispatched.runId),
    ).toEqual({ n: 1 });
  });

  test("an unknown run answers 404", async () => {
    const { url, cookie } = await start();

    const response = await fetch(`${url}/api/runs/run-nobody/cancel`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
    });

    expect(response.status).toBe(404);
  });

  test("a foreign Origin is refused", async () => {
    const { url, cookie } = await start();

    const response = await fetch(`${url}/api/runs/run-1/cancel`, {
      method: "POST",
      headers: { Origin: "https://evil.example.test", Cookie: cookie },
    });

    expect(response.status).toBe(403);
  });

  test("without a session cookie the answer is the one 401", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/api/runs/run-1/cancel`, {
      method: "POST",
      headers: { Origin: origin },
    });

    expect(response.status).toBe(401);
  });
});
