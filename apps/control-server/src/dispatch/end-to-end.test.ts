import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { CommandOutbox, migrate } from "@cc-web/control-db";
import { acceptCommand, migrateRunnerDb } from "@cc-web/runner-db";
import { ReconnectLoop } from "../../../runner/src/connection/reconnect-loop.ts";
import { dialWebSocket } from "../../../runner/src/connection/websocket-link.ts";
import { asCommandEnvelope } from "../../../runner/src/execution/envelope.ts";
import { AuthService } from "../auth/auth-service.ts";
import { createSigner } from "../auth/tokens.ts";
import { createServer, type ServerHandle } from "../server.ts";

/**
 * Dispatch across the real socket (§9.2, §9.3, §14.3).
 *
 * Every other dispatch test fakes one side of the wire. This one runs the real
 * control server, the real outbox, the real dispatcher and the real runner loop
 * against a real socket, because the failures that survive unit tests are the
 * ones where the two halves disagree about a message name or a field.
 *
 * The property being proven is the one the whole durable-delivery design exists
 * for: a command enqueued while the runner is away is delivered when it comes
 * back, and is not executed twice when it comes back again.
 */

const origin = "https://cc.example.test";

let handle: ServerHandle | undefined;
let loop: ReconnectLoop | undefined;

afterEach(() => {
  loop?.stop();
  loop = undefined;
  handle?.stop();
  handle = undefined;
});

function startServer(
  db: Database,
  outbox: CommandOutbox,
  options: { retryTickMs?: number } = {},
): string {
  handle = createServer({
    db,
    auth: new AuthService({ db, signer: createSigner(new Uint8Array(32).fill(11)) }),
    allowedOrigins: [origin],
    verifyRunnerCredential: (credential) =>
      credential === "cck_valid"
        ? { ok: true, runnerId: "runner-a", ownerId: "user-1" }
        : { ok: false, reason: "unknown" },
    outbox,
    ...options,
  });

  return `ws://127.0.0.1:${handle.server.port}/ws/runner`;
}

function runnerLoop(
  url: string,
  inbox: Database,
  executed: string[],
  ready: { value: boolean },
): ReconnectLoop {
  return new ReconnectLoop({
    runnerId: "runner-a",
    dial: () => dialWebSocket({ url, credential: "cck_valid" }),
    hello: () => ({
      protocolVersion: 1,
      runnerId: "runner-a",
      bootId: "boot-1",
      runnerVersion: "0.0.0",
      sdkVersion: "0.3.309",
      platform: "linux/x64",
      maxConcurrentRuns: 1,
      activeRuns: [],
      eventOffsets: [],
    }),
    inventory: () => [],
    sleep: async () => {},
    onEvent: (event) => {
      if (event.type === "ready") ready.value = true;
    },
    onCommand: async (command) => {
      // The real inbox, which is the contract this test is about: a redelivery
      // must return the stored receipt and not look like new work (§9.3).
      // Execution is a separate concern and is not part of this test.
      const record = command as Record<string, unknown>;
      const parsed = asCommandEnvelope(record);
      const commandId = typeof record["commandId"] === "string" ? record["commandId"] : "";
      const attemptId = typeof record["attemptId"] === "string" ? record["attemptId"] : "";

      if (parsed === undefined) {
        return { receipt: { commandId, attemptId, accepted: false, reason: "malformed" } };
      }

      const result = acceptCommand(inbox, parsed, { localRunnerId: "runner-a" });
      if (!result.ok) {
        return { receipt: { commandId, attemptId, accepted: false, reason: result.reason } };
      }
      if (!result.duplicate) executed.push(commandId);
      return { receipt: { commandId, attemptId, accepted: true } };
    },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

function controlDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function runnerInbox() {
  const db = new Database(":memory:");
  migrateRunnerDb(db);
  return db;
}

const command = {
  commandId: "cmd-1",
  runnerId: "runner-a",
  kind: "run.start" as const,
  payload: { prompt: "hello" },
  issuedAt: "2026-10-23T00:00:00.000Z",
  sessionId: "session-1",
  runId: "run-1",
  attemptId: "attempt-1",
  workspaceId: "workspace-1",
};

describe("dispatch over a real socket", () => {
  test("a command queued while the runner is away is delivered when it connects", async () => {
    const db = controlDb();
    const outbox = new CommandOutbox(db);
    await outbox.enqueue(command);

    const url = startServer(db, outbox);
    const inbox = runnerInbox();
    const executed: string[] = [];
    const ready = { value: false };

    loop = runnerLoop(url, inbox, executed, ready);
    await loop.start();
    await waitFor(() => ready.value && executed.length > 0);

    expect(executed).toEqual(["cmd-1"]);
    // The receipt reached the server: the command is retired from delivery.
    expect(outbox.get("cmd-1")?.deliveryState).toBe("accepted");
  });

  test("a reconnecting runner is offered the same command and does not run it twice", async () => {
    const db = controlDb();
    const outbox = new CommandOutbox(db);
    await outbox.enqueue(command);

    const url = startServer(db, outbox);
    const inbox = runnerInbox();
    const executed: string[] = [];
    const ready = { value: false };

    loop = runnerLoop(url, inbox, executed, ready);
    await loop.start();
    await waitFor(() => ready.value && executed.length > 0);

    // The receipt may be lost with the socket. Force the state back to
    // deliverable, which is exactly what a lost ACK looks like to the server.
    outbox.markSent("cmd-1");
    db.query("UPDATE command_outbox SET delivery_state = 'pending' WHERE command_id = ?").run(
      "cmd-1",
    );

    // Second connection, same inbox: the runner must answer from the stored
    // receipt rather than appending a second execution (§9.3).
    loop.stop();
    const ready2 = { value: false };
    loop = runnerLoop(url, inbox, executed, ready2);
    await loop.start();
    await waitFor(() => ready2.value);
    await Bun.sleep(200);

    expect(executed).toEqual(["cmd-1"]);
    expect(outbox.get("cmd-1")?.deliveryState).toBe("accepted");
  });

  test("a command the runner refuses is retired with the runner's reason", async () => {
    const db = controlDb();
    const outbox = new CommandOutbox(db);
    // Already expired by the time it is delivered: §9.5 says a start that sat
    // in a queue must not launch just because it is still there.
    await outbox.enqueue({ ...command, expiresAt: "2026-10-23T00:00:00.000Z" });

    const url = startServer(db, outbox);
    const inbox = runnerInbox();
    const executed: string[] = [];
    const ready = { value: false };

    loop = runnerLoop(url, inbox, executed, ready);
    await loop.start();
    await waitFor(() => ready.value);
    await waitFor(() => outbox.get("cmd-1")?.deliveryState === "rejected");

    expect(executed).toEqual([]);
    expect(outbox.get("cmd-1")).toMatchObject({
      deliveryState: "rejected",
      rejectionReason: "expired",
    });
  });

  test("a command dispatched while the runner is ready reaches it without waiting for a reconnect", async () => {
    const db = controlDb();
    const outbox = new CommandOutbox(db);

    const url = startServer(db, outbox);
    const inbox = runnerInbox();
    const executed: string[] = [];
    const ready = { value: false };

    loop = runnerLoop(url, inbox, executed, ready);
    await loop.start();
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    // The production path: the scheduler decides and enqueues, and the delivery
    // happens as part of that call. A design where the caller has to remember a
    // second `drain()` is a design where someone forgets it, and the run sits in
    // the outbox until the runner happens to reconnect.
    const decision = await handle!.scheduler!.dispatch(
      {
        sessionId: "session-1",
        runId: "run-1",
        attemptId: "attempt-1",
        workspaceId: "workspace-1",
        prompt: "hello",
        ownerId: "user-1",
      },
      { runnerId: "runner-a", state: "ready", maxConcurrentRuns: 1, activeRuns: 0 },
    );

    expect(decision.ok).toBe(true);
    await waitFor(() => executed.length > 0);
    expect(executed).toHaveLength(1);
    expect(outbox.get((decision as { commandId: string }).commandId)?.deliveryState).toBe(
      "accepted",
    );
  });
});

describe("queued run promotion", () => {
  test("a workspace-busy start waits and retries over the socket without incoming activity", async () => {
    const db = controlDb();
    const outbox = new CommandOutbox(db);
    const url = startServer(db, outbox, { retryTickMs: 10 });
    const deliveries: Array<{ commandId: string; runId: string; at: number }> = [];
    const link = await dialWebSocket({ url, credential: "cck_valid" });
    let ready = false;
    let unlockAt = Number.POSITIVE_INFINITY;
    try {
      link.onMessage((raw) => {
        const frame = JSON.parse(raw) as Record<string, unknown>;
        if (frame["type"] === "hello.ok") {
          link.send(JSON.stringify({ type: "reconcile", runner: [], workspaces: [] }));
        }
        if (frame["type"] === "reconcile.ok") ready = true;
        if (frame["type"] !== "command") return;
        const record = frame["command"] as Record<string, unknown>;
        const now = Date.now();
        deliveries.push({
          commandId: String(record["commandId"]),
          runId: String(record["runId"]),
          at: now,
        });
        if (deliveries.length === 1) {
          unlockAt = now + 500;
          return; // The test holds the first receipt across several retry ticks.
        }
        const accepted = now >= unlockAt;
        link.send(
          JSON.stringify({
            type: "command.receipt",
            commandId: record["commandId"],
            attemptId: record["attemptId"],
            accepted,
            ...(!accepted ? { reason: "workspace_busy" } : {}),
          }),
        );
      });
      link.send(
        JSON.stringify({
          type: "hello",
          hello: {
            protocolVersion: 1,
            runnerId: "runner-a",
            bootId: "boot-retry",
            runnerVersion: "0.0.0",
            sdkVersion: "0.3.309",
            platform: "linux/x64",
            maxConcurrentRuns: 1,
            activeRuns: [],
            eventOffsets: [],
          },
        }),
      );
      await waitFor(() => ready && handle!.runnerGateway.stateOf("runner-a") === "ready");
      const decision = await handle!.scheduler.dispatch(
        {
          sessionId: "retry-session",
          ownerId: "user-1",
          workspaceId: "workspace-1",
          runId: "retry-run",
          attemptId: "retry-attempt",
          prompt: "Continue when the previous SDK stream has released its lock",
        },
        { runnerId: "runner-a", state: "ready", maxConcurrentRuns: 1, activeRuns: 0 },
      );
      if (!decision.ok) throw new Error("dispatch failed");
      await waitFor(() => deliveries.length > 0);
      const sibling = await handle!.scheduler.dispatch(
        {
          sessionId: "retry-session",
          ownerId: "user-1",
          workspaceId: "workspace-1",
          runId: "queued-sibling",
          attemptId: "sibling-attempt",
          prompt: "Wait behind the refused run",
        },
        { runnerId: "runner-a", state: "ready", maxConcurrentRuns: 1, activeRuns: 1 },
      );
      expect(sibling).toMatchObject({ ok: true, queued: true });
      await Bun.sleep(70);
      expect(deliveries).toHaveLength(1);
      const rejectedAt = Date.now();
      link.send(
        JSON.stringify({
          type: "command.receipt",
          commandId: decision.commandId,
          attemptId: "retry-attempt",
          accepted: false,
          reason: "workspace_busy",
        }),
      );
      await waitFor(() => {
        const row = outbox.get(decision.commandId);
        return row?.deliveryState === "accepted" || row?.rejectionReason === "queue_abandoned";
      });
      expect(outbox.get(decision.commandId)?.deliveryState).toBe("accepted");
      expect(deliveries).toHaveLength(2);
      expect(deliveries[1]!.at - rejectedAt).toBeGreaterThanOrEqual(1_000);
      expect(new Set(deliveries.map((delivery) => delivery.commandId)).size).toBe(1);
      expect(db.query("SELECT type FROM run_events WHERE type = 'run.failed'").all()).toEqual([]);
    } finally {
      link.close();
    }
  });

  test("a queued run is delivered over the socket after the first run's terminal event", async () => {
    const db = controlDb();
    db.query(
      "INSERT INTO users (id, username, password_hash, token_version, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("user-1", "owner", "hash", 1, Date.now());

    const outbox = new CommandOutbox(db);
    const url = startServer(db, outbox);
    const inbox = runnerInbox();
    const received: string[] = [];

    const link = await dialWebSocket({ url, credential: "cck_valid" });
    const opened = new Promise<void>((resolve) => {
      link.onMessage((raw) => {
        const frame = JSON.parse(raw) as Record<string, unknown>;
        if (frame["type"] === "hello.ok") {
          link.send(JSON.stringify({ type: "reconcile", runner: [], workspaces: [] }));
        }
        if (frame["type"] === "reconcile.ok") resolve();
        if (frame["type"] === "command") {
          const record = frame["command"] as Record<string, unknown>;
          const parsed = asCommandEnvelope(record);
          const commandId = typeof record["commandId"] === "string" ? record["commandId"] : "";
          const attemptId = typeof record["attemptId"] === "string" ? record["attemptId"] : "";
          if (parsed !== undefined) {
            const result = acceptCommand(inbox, parsed, { localRunnerId: "runner-a" });
            if (result.ok && !result.duplicate) received.push(commandId);
            link.send(
              JSON.stringify({
                type: "command.receipt",
                commandId,
                attemptId,
                accepted: result.ok,
                ...("reason" in result ? { reason: result.reason } : {}),
              }),
            );
          }
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
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");

    try {
      const first = await handle!.scheduler!.dispatch(
        {
          sessionId: "session-1",
          runId: "run-1",
          attemptId: "attempt-1",
          workspaceId: "workspace-1",
          prompt: "one",
          ownerId: "user-1",
        },
        { runnerId: "runner-a", state: "ready", maxConcurrentRuns: 1, activeRuns: 0 },
      );
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("first dispatch failed");

      const second = await handle!.scheduler!.dispatch(
        {
          sessionId: "session-1",
          runId: "run-2",
          attemptId: "attempt-2",
          workspaceId: "workspace-1",
          prompt: "two",
          ownerId: "user-1",
        },
        { runnerId: "runner-a", state: "ready", maxConcurrentRuns: 1, activeRuns: 0 },
      );
      expect(second.ok).toBe(true);
      expect((second as { queued: boolean }).queued).toBe(true);
      if (!second.ok) throw new Error("second dispatch failed");

      await waitFor(() => received.includes(first.commandId));

      link.send(
        JSON.stringify({
          type: "events",
          events: [
            {
              protocolVersion: 1,
              eventId: "evt-e2e-1",
              runnerId: "runner-a",
              bootId: "boot-1",
              sessionId: "session-1",
              runId: "run-1",
              attemptId: "attempt-1",
              localSequence: 1,
              occurredAt: new Date().toISOString(),
              type: "run.finished",
              payload: {},
            },
          ],
        }),
      );

      await waitFor(() => received.includes(second.commandId));
    } finally {
      link.close();
    }
  });
});
