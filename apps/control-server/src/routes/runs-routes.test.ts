import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  CommandOutbox,
  createProfile,
  issueRunnerCredential,
  migrate,
  upsertRunnerWorkspaces,
  verifyRunnerCredential,
} from "@cc-web/control-db";
import { EFFORT_LEVELS, MODEL_IDS, type RunnerModel } from "@cc-web/protocol";
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
let links: Link[] = [];

afterEach(() => {
  for (const link of links) link.close();
  links = [];
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
  return { db, url: `http://127.0.0.1:${handle.server.port}`, cookie, credential, auth };
}

/**
 * A runner that completes the §6.2 handshake and answers commands from the real
 * inbox. Emits nothing on its own; the tests push events through `send`.
 *
 * Several tests hold two runners at once, so every link is kept for the
 * afterEach sweep. The hello carries the declared workspaces exactly like the
 * real runner's does (Task 8) — omitting them declares none, which is what an
 * older runner would do.
 */
async function connectRunner(
  url: string,
  credential: string,
  inbox: Database,
  options: {
    runnerId?: string;
    workspaces?: Array<{ workspaceId: string; path: string; branches?: string[] }>;
    /** What this runner's Claude Code offers; absent means pre-discovery. */
    models?: RunnerModel[];
  } = {},
) {
  const runnerId = options.runnerId ?? "runner-a";
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
        // The real runner re-carries its declaration on every reconcile (Task
        // 8); an empty one here would wipe what the hello just stored.
        link.send(
          JSON.stringify({
            type: "reconcile",
            runner: [],
            workspaces: options.workspaces ?? [],
          }),
        );
      }
      if (frame["type"] === "reconcile.ok") resolve();

      if (frame["type"] === "command") {
        const record = frame["command"] as Record<string, unknown>;
        received.push(record);
        const parsed = asCommandEnvelope(record);
        const result =
          parsed === undefined
            ? { ok: false as const, reason: "malformed" }
            : acceptCommand(inbox, parsed, { localRunnerId: runnerId });
        link.send(
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
        runnerId,
        bootId: `boot-${runnerId}`,
        runnerVersion: "0.0.0",
        sdkVersion: "0.3.309",
        platform: "linux/x64",
        maxConcurrentRuns: 1,
        activeRuns: [],
        eventOffsets: [],
        workspaces: options.workspaces ?? [],
        ...(options.models === undefined ? {} : { models: options.models }),
      },
    }),
  );

  await opened;
  return {
    received,
    send: (frame: Record<string, unknown>) => link.send(JSON.stringify(frame)),
    link,
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

async function dispatch(
  url: string,
  cookie: string,
  prompt: string,
  sessionId = "session-1",
  extra: Record<string, unknown> = {},
) {
  return fetch(`${url}/api/sessions/${sessionId}/runs`, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, ...extra }),
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

describe("the model on POST /api/sessions/:id/runs", () => {
  test("a chosen model travels in the run.start payload", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", model: "opus" }),
    });
    expect(response.status).toBe(202);

    await waitFor(() =>
      (inbox.query("SELECT payload FROM command_inbox").all() as Array<{ payload: string }>).some(
        (row) =>
          (JSON.parse(row.payload) as { prompt?: string }).prompt === "hello" &&
          (JSON.parse(row.payload) as { model?: string }).model === "opus",
      ),
    );
  });

  test("every MODEL_IDS member is accepted, not just the tested one", async () => {
    // Drift pin: the route's validation set is built from the protocol's
    // MODEL_IDS, so a member added there must be dispatchable here without a
    // second edit that someone forgets.
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    for (const model of MODEL_IDS) {
      // One fresh session per model (a dispatched run pins its session), and
      // the slot is released between dispatches the same way the terminal
      // events do it — the §11.3 MVP capacity is one run at a time.
      const response = await fetch(`${url}/api/sessions/session-model-${model}/runs`, {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: `hello ${model}`, model }),
      });
      expect(response.status).toBe(202);
      const { runId } = (await response.json()) as { runId: string };
      handle!.scheduler.release(runId);
    }
  });

  test("an unknown model is a bad request, not a silent default", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", model: "gpt-5" }),
    });

    expect(response.status).toBe(400);
    expect((inbox.query("SELECT COUNT(*) AS n FROM command_inbox").get() as { n: number }).n).toBe(
      0,
    );
  });

  test("a custom model the runner advertises is accepted", async () => {
    // §5.2: the runner's own Claude Code is the authority on its lineup — an
    // operator-configured name like "pro" is not in MODEL_IDS and must still run.
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox, {
      models: [
        {
          value: "pro",
          displayName: "pro",
          description: "Custom Opus model",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
      ],
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await dispatch(url, cookie, "hello", "session-1", { model: "pro" });
    expect(response.status).toBe(202);

    await waitFor(() =>
      (inbox.query("SELECT payload FROM command_inbox").all() as Array<{ payload: string }>).some(
        (row) => (JSON.parse(row.payload) as { model?: string }).model === "pro",
      ),
    );
  });

  test("a model the runner did not advertise is refused", async () => {
    // The advertised list replaces the fallback: a runner that told the server
    // what it has must not be sent a model it did not name, even one MODEL_IDS
    // would have allowed.
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox, {
      models: [
        {
          value: "pro",
          displayName: "pro",
          description: "",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
      ],
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await dispatch(url, cookie, "hello", "session-1", { model: "opus" });
    expect(response.status).toBe(400);
    expect((inbox.query("SELECT COUNT(*) AS n FROM command_inbox").get() as { n: number }).n).toBe(
      0,
    );
  });

  test("an absent model is omitted from the payload", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
    expect(response.status).toBe(202);

    await waitFor(() =>
      (inbox.query("SELECT payload FROM command_inbox").all() as Array<{ payload: string }>).some(
        (row) => (JSON.parse(row.payload) as { prompt?: string }).prompt === "hello",
      ),
    );

    const payloads = inbox.query("SELECT payload FROM command_inbox").all() as Array<{
      payload: string;
    }>;
    expect(
      payloads.some((row) => "model" in (JSON.parse(row.payload) as Record<string, unknown>)),
    ).toBe(false);
  });
});

describe("effort and ultracode on POST /api/sessions/:id/runs", () => {
  test("a chosen effort and ultracode travel in the payload", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await dispatch(url, cookie, "hello", "session-1", {
      effort: "xhigh",
      ultracode: true,
    });
    expect(response.status).toBe(202);

    await waitFor(() =>
      (inbox.query("SELECT payload FROM command_inbox").all() as Array<{ payload: string }>).some(
        (row) => {
          const payload = JSON.parse(row.payload) as { effort?: string; ultracode?: boolean };
          return payload.effort === "xhigh" && payload.ultracode === true;
        },
      ),
    );
  });

  test("every EFFORT_LEVELS member is accepted", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    for (const effort of EFFORT_LEVELS) {
      const response = await dispatch(url, cookie, `hello ${effort}`, `session-effort-${effort}`, {
        effort,
      });
      expect(response.status).toBe(202);
      const { runId } = (await response.json()) as { runId: string };
      handle!.scheduler.release(runId);
    }
  });

  test("an unknown effort is refused, not downgraded", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await dispatch(url, cookie, "hello", "session-1", { effort: "extreme" });
    expect(response.status).toBe(400);
    expect((inbox.query("SELECT COUNT(*) AS n FROM command_inbox").get() as { n: number }).n).toBe(
      0,
    );
  });

  test("a non-boolean ultracode is refused", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await dispatch(url, cookie, "hello", "session-1", { ultracode: "yes" });
    expect(response.status).toBe(400);
  });

  test("an absent effort and ultracode are omitted from the payload", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await dispatch(url, cookie, "hello");
    expect(response.status).toBe(202);

    await waitFor(() =>
      (inbox.query("SELECT payload FROM command_inbox").all() as Array<{ payload: string }>).some(
        (row) => (JSON.parse(row.payload) as { prompt?: string }).prompt === "hello",
      ),
    );

    const payloads = inbox.query("SELECT payload FROM command_inbox").all() as Array<{
      payload: string;
    }>;
    for (const row of payloads) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      expect("effort" in payload).toBe(false);
      expect("ultracode" in payload).toBe(false);
    }
  });
});

describe("the resumeSessionId on POST /api/sessions/:id/runs", () => {
  test("a resumeSessionId travels in the run.start payload", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", resumeSessionId: "prev-session-id" }),
    });
    expect(response.status).toBe(202);

    await waitFor(() =>
      (inbox.query("SELECT payload FROM command_inbox").all() as Array<{ payload: string }>).some(
        (row) =>
          (JSON.parse(row.payload) as { prompt?: string }).prompt === "hello" &&
          (JSON.parse(row.payload) as { resumeSessionId?: string }).resumeSessionId ===
            "prev-session-id",
      ),
    );
  });

  test("an empty resumeSessionId is a bad request", async () => {
    const { url, cookie } = await start();

    const response = await dispatch(url, cookie, "hello", "session-empty", {
      resumeSessionId: "",
    });

    expect(response.status).toBe(400);
  });

  test("a whitespace-only resumeSessionId is a bad request", async () => {
    const { url, cookie } = await start();

    const response = await dispatch(url, cookie, "hello", "session-ws", {
      resumeSessionId: "   ",
    });

    expect(response.status).toBe(400);
  });

  test("a non-string resumeSessionId is a bad request", async () => {
    const { url, cookie } = await start();

    const response = await dispatch(url, cookie, "hello", "session-num", {
      resumeSessionId: 42,
    });

    expect(response.status).toBe(400);
  });

  test("an absent resumeSessionId is omitted from the payload", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
    expect(response.status).toBe(202);

    await waitFor(() =>
      (inbox.query("SELECT payload FROM command_inbox").all() as Array<{ payload: string }>).some(
        (row) => (JSON.parse(row.payload) as { prompt?: string }).prompt === "hello",
      ),
    );

    const payloads = inbox.query("SELECT payload FROM command_inbox").all() as Array<{
      payload: string;
    }>;
    expect(
      payloads.some(
        (row) => "resumeSessionId" in (JSON.parse(row.payload) as Record<string, unknown>),
      ),
    ).toBe(false);
  });
});

describe("placement pins the runner through the workspace", () => {
  test("a workspace declared on one runner only dispatches to that runner", async () => {
    const { db, url, cookie, credential } = await start();
    issueRunnerCredential(db, { id: "runner-b", ownerId: "user-1" });

    // runner-a is the earlier runner and is ready — but it declares a different
    // workspace. Only runner-b declares "default", so the run must land there
    // even though the legacy first-ready rule would have chosen runner-a.
    const inboxA = runnerInbox();
    await connectRunner(url, credential, inboxA, {
      workspaces: [{ workspaceId: "other", path: "/srv/a" }],
    });
    const inboxB = runnerInbox();
    await connectRunner(
      url,
      issueRunnerCredential(db, { id: "runner-b", ownerId: "user-1" }).credential,
      inboxB,
      { runnerId: "runner-b", workspaces: [{ workspaceId: "default", path: "/srv/b" }] },
    );
    await waitFor(
      () =>
        handle!.runnerGateway.stateOf("runner-a") === "ready" &&
        handle!.runnerGateway.stateOf("runner-b") === "ready",
    );

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", workspaceId: "default" }),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { runnerId: string };
    expect(body.runnerId).toBe("runner-b");

    await waitFor(
      () =>
        (inboxB.query("SELECT COUNT(*) AS n FROM command_inbox").get() as { n: number }).n === 1,
    );
    expect((inboxA.query("SELECT COUNT(*) AS n FROM command_inbox").get() as { n: number }).n).toBe(
      0,
    );
  });

  test("a workspace no runner declared is a bad request with an empty outbox", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", workspaceId: "nope" }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("unknown_workspace");
    expect((inbox.query("SELECT COUNT(*) AS n FROM command_inbox").get() as { n: number }).n).toBe(
      0,
    );
  });

  test("a runner owned by someone else is refused with unknown_runner", async () => {
    const { db, url, cookie, credential } = await start();
    db.query(
      "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("user-2", "other-owner", "hash", 1, Date.now());
    issueRunnerCredential(db, { id: "runner-x", ownerId: "user-2" });

    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", runnerId: "runner-x" }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("unknown_runner");
    expect((inbox.query("SELECT COUNT(*) AS n FROM command_inbox").get() as { n: number }).n).toBe(
      0,
    );
  });

  test("a pinned runner that does not declare the workspace is refused with unknown_workspace", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox, {
      workspaces: [{ workspaceId: "other", path: "/srv/a" }],
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", workspaceId: "default", runnerId: "runner-a" }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("unknown_workspace");
    expect((inbox.query("SELECT COUNT(*) AS n FROM command_inbox").get() as { n: number }).n).toBe(
      0,
    );
  });

  test("among runners declaring the workspace, the first ready in creation order wins", async () => {
    const { db, url, cookie } = await start();
    const b = issueRunnerCredential(db, { id: "runner-b", ownerId: "user-1" });
    // A strict creation order makes the deterministic tie-break observable.
    db.query("UPDATE runners SET created_at = ? WHERE id = ?").run(1000, "runner-a");
    db.query("UPDATE runners SET created_at = ? WHERE id = ?").run(2000, "runner-b");
    // runner-a declares the workspace but is not connected: its last declaration
    // is what the workspaces table still holds (seeded directly, as storage).
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/a" }]);

    const inboxB = runnerInbox();
    await connectRunner(url, b.credential, inboxB, {
      runnerId: "runner-b",
      workspaces: [{ workspaceId: "default", path: "/srv/b" }],
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-b") === "ready");

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", workspaceId: "default" }),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { runnerId: string };
    expect(body.runnerId).toBe("runner-b");

    await waitFor(
      () =>
        (inboxB.query("SELECT COUNT(*) AS n FROM command_inbox").get() as { n: number }).n === 1,
    );
  });

  test("a revoked runner is never a candidate, even one that declared the workspace", async () => {
    const { db, url, cookie } = await start();
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "default", path: "/srv/a" }]);
    db.query("UPDATE runners SET revoked_at = ? WHERE id = ?").run(Date.now(), "runner-a");

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", workspaceId: "default" }),
    });

    // Nothing declares "default" anymore — and a revoked declaration must not
    // resurrect a candidate, so the answer is the 400, not a dispatch.
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("unknown_workspace");
  });

  test("an absent workspaceId keeps the legacy first-ready dispatch", async () => {
    const { db, url, cookie, credential } = await start();
    const b = issueRunnerCredential(db, { id: "runner-b", ownerId: "user-1" });
    db.query("UPDATE runners SET created_at = ? WHERE id = ?").run(1000, "runner-a");
    db.query("UPDATE runners SET created_at = ? WHERE id = ?").run(2000, "runner-b");
    upsertRunnerWorkspaces(db, "runner-a", [{ workspaceId: "other", path: "/srv/a" }]);

    const inboxA = runnerInbox();
    await connectRunner(url, credential, inboxA);
    const inboxB = runnerInbox();
    await connectRunner(url, b.credential, inboxB, { runnerId: "runner-b" });
    await waitFor(
      () =>
        handle!.runnerGateway.stateOf("runner-a") === "ready" &&
        handle!.runnerGateway.stateOf("runner-b") === "ready",
    );

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { runnerId: string };
    // Both runners are ready; legacy placement ignores workspaces and the
    // earliest runner wins.
    expect(body.runnerId).toBe("runner-a");

    await waitFor(
      () =>
        (inboxA.query("SELECT COUNT(*) AS n FROM command_inbox").get() as { n: number }).n === 1,
    );
    expect((inboxB.query("SELECT COUNT(*) AS n FROM command_inbox").get() as { n: number }).n).toBe(
      0,
    );
  });
});

/**
 * The session pin (§2.3, ADR-006): the first accepted dispatch records where a
 * session ran, and every later run of that session rides the pin — never
 * re-running placement, never failing over. The pin is immutable; a body that
 * contradicts it is refused with its own code, and another owner's session is
 * simply not there (404).
 */
describe("an existing session rides its pin", () => {
  /** The terminal event the real daemon reports, so the session frees up. */
  function finishedEvent(runnerId: string, runId: string, n: number) {
    return {
      protocolVersion: 1,
      eventId: `evt-pin-${n}`,
      runnerId,
      bootId: `boot-${runnerId}`,
      sessionId: "session-1",
      runId,
      attemptId: `attempt-pin-${n}`,
      localSequence: 1,
      occurredAt: new Date().toISOString(),
      type: "run.finished",
      payload: {},
    };
  }

  function inboxCount(inbox: Database): number {
    return (inbox.query("SELECT COUNT(*) AS n FROM command_inbox").get() as { n: number }).n;
  }

  function payloadWorkspaceIds(inbox: Database): Array<string | undefined> {
    return (
      inbox.query("SELECT payload FROM command_inbox ORDER BY rowid").all() as {
        payload: string;
      }[]
    ).map((row) => (JSON.parse(row.payload) as { workspaceId?: string }).workspaceId);
  }

  test("a session's second run returns to its pinned runner, not the earliest ready one", async () => {
    const { db, url, cookie, credential } = await start();
    const credB = issueRunnerCredential(db, { id: "runner-b", ownerId: "user-1" }).credential;
    const inbox = runnerInbox();
    const inboxB = runnerInbox();
    await connectRunner(url, credential, inbox);
    const runnerB = await connectRunner(url, credB, inboxB, { runnerId: "runner-b" });
    await waitFor(
      () =>
        handle!.runnerGateway.stateOf("runner-a") === "ready" &&
        handle!.runnerGateway.stateOf("runner-b") === "ready",
    );

    // Take runner-a out of the picture for the first dispatch: candidates
    // exclude revoked runners, so the run lands on runner-b and pins there.
    db.query("UPDATE runners SET revoked_at = ? WHERE id = ?").run(Date.now(), "runner-a");
    const firstResponse = await dispatch(url, cookie, "hello");
    expect(firstResponse.status).toBe(202);
    const first = (await firstResponse.json()) as { runnerId: string; runId: string };
    expect(first.runnerId).toBe("runner-b");
    await waitFor(() => inboxCount(inboxB) === 1);

    // runner-a comes back; the next run of the session must still go to the
    // pinned runner-b, even though runner-a is the earliest ready candidate.
    db.query("UPDATE runners SET revoked_at = NULL WHERE id = ?").run("runner-a");
    runnerB.send({ type: "events", events: [finishedEvent("runner-b", first.runId, 1)] });
    await waitFor(() => handle!.scheduler.activeRunFor("session-1") === undefined);

    const second = await dispatch(url, cookie, "next");
    expect(second.status).toBe(202);
    expect(((await second.json()) as { runnerId: string }).runnerId).toBe("runner-b");
  });

  test("a prompt-only rerun rides the pinned workspace", async () => {
    const { db, url, cookie, credential } = await start();
    const inbox = runnerInbox();
    const runner = await connectRunner(url, credential, inbox, {
      workspaces: [{ workspaceId: "ws", path: "/srv/a" }],
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    // The pin is born from an explicit workspace choice, not the legacy default.
    const firstResponse = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", workspaceId: "ws" }),
    });
    expect(firstResponse.status).toBe(202);
    const first = (await firstResponse.json()) as { runId: string };
    await waitFor(() => inboxCount(inbox) === 1);

    (runner.send as (frame: Record<string, unknown>) => void)({
      type: "events",
      events: [finishedEvent("runner-a", first.runId, 1)],
    });
    await waitFor(() => handle!.scheduler.activeRunFor("session-1") === undefined);

    const second = await dispatch(url, cookie, "next");
    expect(second.status).toBe(202);
    await waitFor(() => inboxCount(inbox) === 2);

    // Both payloads carry the pinned workspace — a prompt-only rerun must not
    // silently fall back to "default".
    expect(payloadWorkspaceIds(inbox)).toEqual(["ws", "ws"]);
    expect(db.query("SELECT workspace_id FROM sessions WHERE id = ?").get("session-1")).toEqual({
      workspace_id: "ws",
    });
  });

  test("a different workspace than the pin is refused with session_pinned", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    const runner = await connectRunner(url, credential, inbox, {
      workspaces: [{ workspaceId: "ws", path: "/srv/a" }],
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const first = (await (await dispatch(url, cookie, "hello")).json()) as { runId: string };
    expect(first.runId).toBeTruthy();
    await waitFor(() => inboxCount(inbox) === 1);
    (runner.send as (frame: Record<string, unknown>) => void)({
      type: "events",
      events: [finishedEvent("runner-a", first.runId, 1)],
    });
    await waitFor(() => handle!.scheduler.activeRunFor("session-1") === undefined);

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "next", workspaceId: "other" }),
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toBe("session_pinned");
    expect(inboxCount(inbox)).toBe(1);
  });

  test("a malformed runnerId on a pinned session is a 400, not a conflict", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    const runner = await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const first = (await (await dispatch(url, cookie, "hello")).json()) as { runId: string };
    expect(first.runId).toBeTruthy();
    await waitFor(() => inboxCount(inbox) === 1);
    (runner.send as (frame: Record<string, unknown>) => void)({
      type: "events",
      events: [finishedEvent("runner-a", first.runId, 1)],
    });
    await waitFor(() => handle!.scheduler.activeRunFor("session-1") === undefined);

    // A non-string runnerId is malformed input and must read as such — a 409
    // would tell the operator the session cannot move, which is not the
    // problem with `42`.
    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "next", runnerId: 42 }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("bad request");
  });

  test("a different runner than the pin is refused with session_pinned", async () => {
    const { db, url, cookie, credential } = await start();
    const credB = issueRunnerCredential(db, { id: "runner-b", ownerId: "user-1" }).credential;
    const inbox = runnerInbox();
    const runner = await connectRunner(url, credential, inbox);
    await connectRunner(url, credB, runnerInbox(), { runnerId: "runner-b" });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const first = (await (await dispatch(url, cookie, "hello")).json()) as { runId: string };
    expect(first.runId).toBeTruthy();
    await waitFor(() => inboxCount(inbox) === 1);
    (runner.send as (frame: Record<string, unknown>) => void)({
      type: "events",
      events: [finishedEvent("runner-a", first.runId, 1)],
    });
    await waitFor(() => handle!.scheduler.activeRunFor("session-1") === undefined);

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "next", runnerId: "runner-b" }),
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toBe("session_pinned");
  });

  test("a body that matches the pin is accepted", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    const runner = await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const first = (await (await dispatch(url, cookie, "hello")).json()) as { runId: string };
    expect(first.runId).toBeTruthy();
    await waitFor(() => inboxCount(inbox) === 1);
    (runner.send as (frame: Record<string, unknown>) => void)({
      type: "events",
      events: [finishedEvent("runner-a", first.runId, 1)],
    });
    await waitFor(() => handle!.scheduler.activeRunFor("session-1") === undefined);

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "next", runnerId: "runner-a", workspaceId: "default" }),
    });
    expect(response.status).toBe(202);
    expect(((await response.json()) as { runnerId: string }).runnerId).toBe("runner-a");
  });

  test("an offline pinned runner is refused without failover", async () => {
    const { db, url, cookie, credential } = await start();
    const credB = issueRunnerCredential(db, { id: "runner-b", ownerId: "user-1" }).credential;
    const inbox = runnerInbox();
    const runnerA = await connectRunner(url, credential, inbox);
    await connectRunner(url, credB, runnerInbox(), { runnerId: "runner-b" });
    await waitFor(
      () =>
        handle!.runnerGateway.stateOf("runner-a") === "ready" &&
        handle!.runnerGateway.stateOf("runner-b") === "ready",
    );

    const firstResponse = await dispatch(url, cookie, "hello");
    expect(firstResponse.status).toBe(202);
    const first = (await firstResponse.json()) as { runnerId: string; runId: string };
    expect(first.runnerId).toBe("runner-a");
    await waitFor(() => inboxCount(inbox) === 1);
    (runnerA.send as (frame: Record<string, unknown>) => void)({
      type: "events",
      events: [finishedEvent("runner-a", first.runId, 1)],
    });
    await waitFor(() => handle!.scheduler.activeRunFor("session-1") === undefined);

    // runner-a drops. ADR-006: the session does not migrate — the run waits
    // for its own runner instead of starting half a conversation elsewhere.
    runnerA.link.close();
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") !== "ready");

    const second = await dispatch(url, cookie, "next");
    expect(second.status).toBe(503);
    expect(await second.text()).toBe("runner_offline");
  });

  test("another owner's pin is invisible: 404, no dispatch", async () => {
    const { db, url, cookie, credential, auth } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const first = (await (await dispatch(url, cookie, "hello")).json()) as { runId: string };
    expect(first.runId).toBeTruthy();
    await waitFor(() => inboxCount(inbox) === 1);

    // Another user guesses the session id. The 404 comes before any busy
    // check — existence is not theirs to learn, and nothing is dispatched.
    db.query(
      "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("user-2", "other-owner", "hash", 1, Date.now());
    const cookie2 = `cc_session=${await auth.issueAccessToken("user-2")}`;
    const second = await dispatch(url, cookie2, "next");
    expect(second.status).toBe(404);
    expect(inboxCount(inbox)).toBe(1);
  });

  test("a fresh session dispatches legacy and writes the pin", async () => {
    const { db, url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const first = await dispatch(url, cookie, "hello");
    expect(first.status).toBe(202);

    expect(
      db
        .query("SELECT owner_id, workspace_id, runner_id FROM sessions WHERE id = ?")
        .get("session-1"),
    ).toEqual({
      owner_id: "user-1",
      workspace_id: "default",
      runner_id: "runner-a",
    });
  });

  test("a revoked pinned runner is refused like an offline one", async () => {
    const { db, url, cookie, credential } = await start();
    const inbox = runnerInbox();
    const runner = await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const first = (await (await dispatch(url, cookie, "hello")).json()) as { runId: string };
    expect(first.runId).toBeTruthy();
    await waitFor(() => inboxCount(inbox) === 1);
    runner.send({
      type: "events",
      events: [finishedEvent("runner-a", first.runId, 1)],
    });
    await waitFor(() => handle!.scheduler.activeRunFor("session-1") === undefined);

    // The pinned path never consults placement candidates, so revocation
    // needs its own check — the run must not reach a revoked runner.
    db.query("UPDATE runners SET revoked_at = ? WHERE id = ?").run(Date.now(), "runner-a");
    const second = await dispatch(url, cookie, "next");
    expect(second.status).toBe(503);
    expect(await second.text()).toBe("runner_offline");
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

describe("POST /api/sessions/:id/runs branch (M4)", () => {
  test("a malformed branch name is a bad request, whatever else is true", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox, {
      workspaces: [{ workspaceId: "default", path: "/srv/proj", branches: ["dev"] }],
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    // "..evil" — starts outside the alphabet and hides a path fragment.
    const dots = await dispatch(url, cookie, "hello", "session-1", {
      workspaceId: "default",
      branch: "..evil",
    });
    expect(dots.status).toBe(400);

    const slashdot = await dispatch(url, cookie, "hello", "session-2", {
      workspaceId: "default",
      branch: "a..b",
    });
    expect(slashdot.status).toBe(400);

    const tooLong = await dispatch(url, cookie, "hello", "session-3", {
      workspaceId: "default",
      branch: "a".repeat(300),
    });
    expect(tooLong.status).toBe(400);

    const nonString = await dispatch(url, cookie, "hello", "session-4", {
      workspaceId: "default",
      branch: 42,
    });
    expect(nonString.status).toBe(400);
  });

  test("a branch without a named workspace is a bad request", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox, {
      workspaces: [{ workspaceId: "default", path: "/srv/proj", branches: ["dev"] }],
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await dispatch(url, cookie, "hello", "session-1", { branch: "dev" });

    expect(response.status).toBe(400);
  });

  test("placement narrows to the runner declaring both workspace and branch", async () => {
    const { db, url, cookie, credential } = await start();
    const { credential: credentialB } = issueRunnerCredential(db, {
      id: "runner-b",
      ownerId: "user-1",
    });
    const inboxA = runnerInbox();
    const inboxB = runnerInbox();
    await connectRunner(url, credential, inboxA, {
      workspaces: [{ workspaceId: "default", path: "/srv/a" }],
    });
    await connectRunner(url, credentialB, inboxB, {
      runnerId: "runner-b",
      workspaces: [{ workspaceId: "default", path: "/srv/b", branches: ["dev"] }],
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");
    await waitFor(() => handle!.runnerGateway.stateOf("runner-b") === "ready");

    const response = await dispatch(url, cookie, "hello", "session-1", {
      workspaceId: "default",
      branch: "dev",
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { runnerId: string };
    // runner-a is first in creation order but declares no branches: the
    // branch narrows past it to the declarer.
    expect(body.runnerId).toBe("runner-b");

    // The delivered run.start carries the branch on its payload.
    await waitFor(() => {
      const rows = inboxB.query("SELECT payload FROM command_inbox").all() as {
        payload: string;
      }[];
      return rows.some((row) => (JSON.parse(row.payload) as { branch?: string }).branch === "dev");
    });
  });

  test("a branch nobody declares is unknown_branch, not a wider placement", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox, {
      workspaces: [{ workspaceId: "default", path: "/srv/proj" }],
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await dispatch(url, cookie, "hello", "session-1", {
      workspaceId: "default",
      branch: "dev",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("unknown_branch");
  });

  test("an unknown workspace is reported before the branch", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox, {
      workspaces: [{ workspaceId: "default", path: "/srv/proj", branches: ["dev"] }],
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await dispatch(url, cookie, "hello", "session-1", {
      workspaceId: "nope",
      branch: "dev",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("unknown_workspace");
  });

  test("an explicit runner that does not declare the branch is unknown_branch", async () => {
    const { db, url, cookie, credential } = await start();
    const { credential: credentialB } = issueRunnerCredential(db, {
      id: "runner-b",
      ownerId: "user-1",
    });
    const inboxA = runnerInbox();
    const inboxB = runnerInbox();
    await connectRunner(url, credential, inboxA, {
      workspaces: [{ workspaceId: "default", path: "/srv/a" }],
    });
    await connectRunner(url, credentialB, inboxB, {
      runnerId: "runner-b",
      workspaces: [{ workspaceId: "default", path: "/srv/b", branches: ["dev"] }],
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");
    await waitFor(() => handle!.runnerGateway.stateOf("runner-b") === "ready");

    const response = await dispatch(url, cookie, "hello", "session-1", {
      workspaceId: "default",
      branch: "dev",
      runnerId: "runner-a",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("unknown_branch");
  });

  test("a pinned session validates the branch against the pinned runner's declaration", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox, {
      workspaces: [{ workspaceId: "default", path: "/srv/proj", branches: ["dev"] }],
    });
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const first = await dispatch(url, cookie, "hello", "session-1", {
      workspaceId: "default",
    });
    expect(first.status).toBe(202);
    const pinned = (await first.json()) as { runId: string };
    handle!.scheduler.release(pinned.runId);

    const declared = await dispatch(url, cookie, "more", "session-1", {
      workspaceId: "default",
      branch: "dev",
    });
    expect(declared.status).toBe(202);

    const second = (await declared.json()) as { runId: string };
    handle!.scheduler.release(second.runId);

    const undeclared = await dispatch(url, cookie, "more", "session-1", {
      workspaceId: "default",
      branch: "feature-x",
    });
    expect(undeclared.status).toBe(400);
    expect(await undeclared.text()).toBe("unknown_branch");
  });
});

describe("POST /api/sessions/:id/runs attachmentIds", () => {
  test("attachmentIds are mapped to RunnerAttachmentItem[] in the run.start payload", async () => {
    const { db, url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    // Seed an attachment owned by user-1.
    const attId = "att-dispatch-1";
    db.query(
      "INSERT INTO session_attachments (id, session_id, owner_id, name, mime_type, size, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(attId, "session-1", "user-1", "photo.png", "image/png", 42, "/tmp/x", Date.now());

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", attachmentIds: [attId] }),
    });
    expect(response.status).toBe(202);

    await waitFor(() =>
      (inbox.query("SELECT payload FROM command_inbox").all() as Array<{ payload: string }>).some(
        (row) =>
          (JSON.parse(row.payload) as { prompt?: string }).prompt === "hello" &&
          Array.isArray((JSON.parse(row.payload) as { attachments?: unknown }).attachments),
      ),
    );

    const payloads = inbox.query("SELECT payload FROM command_inbox").all() as Array<{
      payload: string;
    }>;
    const withAtt = payloads.find(
      (row) => (JSON.parse(row.payload) as { prompt?: string }).prompt === "hello",
    );
    expect(withAtt).toBeDefined();
    const payload = JSON.parse(withAtt!.payload) as {
      attachments?: Array<{ id: string; name: string; mimeType: string; size: number }>;
    };
    expect(payload.attachments).toEqual([
      { id: attId, name: "photo.png", mimeType: "image/png", size: 42 },
    ]);
  });

  test("attachmentIds referencing another owner's attachment is a bad request", async () => {
    const { db, url, auth } = await start();
    db.query(
      "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("user-2", "other", "hash", 1, Date.now());
    db.query(
      "INSERT INTO session_attachments (id, session_id, owner_id, name, mime_type, size, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("att-other", "sess-att-other", "user-2", "x.txt", "text/plain", 1, "/tmp/x", Date.now());

    const cookie1 = `cc_session=${await auth.issueAccessToken("user-1")}`;

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie1, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", attachmentIds: ["att-other"] }),
    });
    expect(response.status).toBe(400);
  });

  test("attachmentIds referencing an attachment from a different session of the same owner is a bad request", async () => {
    const { db, url, cookie } = await start();
    db.query(
      "INSERT INTO session_attachments (id, session_id, owner_id, name, mime_type, size, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "att-diff-sess",
      "session-other",
      "user-1",
      "x.txt",
      "text/plain",
      1,
      "/tmp/x",
      Date.now(),
    );

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", attachmentIds: ["att-diff-sess"] }),
    });
    expect(response.status).toBe(400);
  });

  test("a non-array attachmentIds is a bad request", async () => {
    const { url, cookie } = await start();
    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", attachmentIds: "not-an-array" }),
    });
    expect(response.status).toBe(400);
  });

  test("attachmentIds with a non-string element is a bad request", async () => {
    const { url, cookie } = await start();
    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", attachmentIds: [42] }),
    });
    expect(response.status).toBe(400);
  });

  test("an unknown attachmentId is a bad request", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const response = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", attachmentIds: ["does-not-exist"] }),
    });
    expect(response.status).toBe(400);
    expect((inbox.query("SELECT COUNT(*) AS n FROM command_inbox").get() as { n: number }).n).toBe(
      0,
    );
  });
});

/**
 * Profile dispatch (§17.1, §18.1): when the body names a `profileId`, the route
 * resolves it to a `RunProfilePayload` and forwards it in the run.start payload.
 * The cleartext API key travels on the WebSocket frame but is masked in the
 * `command_outbox` row (§4.5 / §7.2).
 */
describe("POST /api/sessions/:id/runs profileId", () => {
  test("resolves a valid profileId and forwards RunProfilePayload in run.start payload", async () => {
    const { db, url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const profile = createProfile(db, {
      ownerId: "user-1",
      name: "9Router",
      endpoint: "http://192.168.2.3:20128",
      authField: "ANTHROPIC_AUTH_TOKEN",
      apiKey: "sk-secret-key",
      modelMapping: { sonnet: "prime" },
      settingsJson: "{}",
    });

    const res = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", profileId: profile.id }),
    });
    expect(res.status).toBe(202);

    // The runner's inbox receives the cleartext payload over the WebSocket frame.
    await waitFor(() =>
      (inbox.query("SELECT payload FROM command_inbox").all() as Array<{ payload: string }>).some(
        (row) => (JSON.parse(row.payload) as { prompt?: string }).prompt === "hello",
      ),
    );
    const sent = inbox.query("SELECT payload FROM command_inbox").all() as Array<{
      payload: string;
    }>;
    const parsed = JSON.parse(sent[0]!.payload) as Record<string, unknown>;
    expect(parsed.profile).toBeDefined();
    const profilePayload = parsed.profile as Record<string, unknown>;
    expect(profilePayload.endpoint).toBe("http://192.168.2.3:20128");
    expect(profilePayload.apiKey).toBe("sk-secret-key");
    expect(profilePayload.name).toBe("9Router");
    expect(profilePayload.authField).toBe("ANTHROPIC_AUTH_TOKEN");
    expect((profilePayload.modelMapping as Record<string, unknown>).sonnet).toBe("prime");
  });

  test("the command_outbox row masks the apiKey while the live frame carries it", async () => {
    const { db, url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const profile = createProfile(db, {
      ownerId: "user-1",
      name: "9Router",
      endpoint: "http://192.168.2.3:20128",
      authField: "ANTHROPIC_AUTH_TOKEN",
      apiKey: "sk-secret-key",
      modelMapping: { sonnet: "prime" },
      settingsJson: "{}",
    });

    const res = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", profileId: profile.id }),
    });
    expect(res.status).toBe(202);

    // Wait for the runner to accept the command (and for the outbox row to exist).
    await waitFor(
      () => (db.query("SELECT COUNT(*) AS n FROM command_outbox").get() as { n: number }).n === 1,
    );

    // The persisted payload must NOT contain the cleartext key.
    const persisted = db.query("SELECT payload FROM command_outbox").get() as { payload: string };
    const persistedParsed = JSON.parse(persisted.payload) as {
      profile?: { apiKey?: string };
    };
    expect(persistedParsed.profile?.apiKey).toBe("[REDACTED]");
    expect(persisted.payload).not.toContain("sk-secret-key");

    // The runner's inbox (delivered via the live frame) DOES contain the key.
    await waitFor(
      () => (inbox.query("SELECT COUNT(*) AS n FROM command_inbox").get() as { n: number }).n === 1,
    );
    const delivered = inbox.query("SELECT payload FROM command_inbox").get() as {
      payload: string;
    };
    const deliveredParsed = JSON.parse(delivered.payload) as {
      profile?: { apiKey?: string };
    };
    expect(deliveredParsed.profile?.apiKey).toBe("sk-secret-key");
  });

  test("an unknown profileId is a bad request with unknown_profile", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const res = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", profileId: "prof_doesnotexist" }),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("unknown_profile");
    expect((inbox.query("SELECT COUNT(*) AS n FROM command_inbox").get() as { n: number }).n).toBe(
      0,
    );
  });

  test("a profile owned by another user is unknown_profile, not leaked", async () => {
    const { db, url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    // Another user owns a profile.
    db.query(
      "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("user-2", "other-owner", "hash", 1, Date.now());
    const foreign = createProfile(db, {
      ownerId: "user-2",
      name: "Foreign",
      endpoint: "http://192.168.2.3:20128",
      authField: "ANTHROPIC_AUTH_TOKEN",
      apiKey: "sk-foreign-key",
      modelMapping: {},
      settingsJson: "{}",
    });

    const res = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", profileId: foreign.id }),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("unknown_profile");
    expect((inbox.query("SELECT COUNT(*) AS n FROM command_inbox").get() as { n: number }).n).toBe(
      0,
    );
  });

  test("an absent profileId omits the profile key from the payload", async () => {
    const { url, cookie, credential } = await start();
    const inbox = runnerInbox();
    await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    const res = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
    expect(res.status).toBe(202);

    await waitFor(() =>
      (inbox.query("SELECT payload FROM command_inbox").all() as Array<{ payload: string }>).some(
        (row) => (JSON.parse(row.payload) as { prompt?: string }).prompt === "hello",
      ),
    );
    const payloads = inbox.query("SELECT payload FROM command_inbox").all() as Array<{
      payload: string;
    }>;
    expect(
      payloads.some((row) => "profile" in (JSON.parse(row.payload) as Record<string, unknown>)),
    ).toBe(false);
  });

  test("a non-string profileId is a bad request", async () => {
    const { url, cookie } = await start();

    const res = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", profileId: 42 }),
    });

    expect(res.status).toBe(400);
  });

  test("an empty-string profileId is a bad request", async () => {
    const { url, cookie } = await start();

    const res = await fetch(`${url}/api/sessions/session-1/runs`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello", profileId: "" }),
    });

    expect(res.status).toBe(400);
  });
});
