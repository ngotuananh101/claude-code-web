import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  CommandOutbox,
  ensureSessionPin,
  issueRunnerCredential,
  listActiveSchedules,
  migrate,
  verifyRunnerCredential,
} from "@cc-web/control-db";
import { PROTOCOL_VERSION } from "@cc-web/protocol";
import { acceptCommand, migrateRunnerDb } from "@cc-web/runner-db";
import type { Link } from "../../../runner/src/connection/reconnect-loop.ts";
import { dialWebSocket } from "../../../runner/src/connection/websocket-link.ts";
import { asCommandEnvelope } from "../../../runner/src/execution/envelope.ts";
import { AuthService } from "../auth/auth-service.ts";
import { createSigner } from "../auth/tokens.ts";
import { createServer, type ServerHandle } from "../server.ts";

/**
 * Schedule projection over the real runner socket (§11.5).
 *
 * This is the one test that proves all three wiring layers at once: the runner
 * gateway accepts the new event type (an unknown type refuses the whole frame,
 * so the ACK is the proof), `onEvents` projects the row, and `stop()` tears the
 * scheduling loop down with the server. The tick itself is exercised in
 * ./schedule-loop.test.ts; the interval here is pushed far out so a tick can
 * never race the assertions.
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
    outbox: new CommandOutbox(db),
    scheduleTickMs: 60_000,
  });
  return { db, url: `http://127.0.0.1:${handle.server.port}`, credential, auth };
}

/**
 * A runner that completes the §6.2 handshake, answers commands from the real
 * inbox and exposes a way to wait for the next `events.ack`.
 */
async function connectRunner(
  url: string,
  credential: string,
  inbox: Database,
  options: { runnerId?: string } = {},
) {
  const runnerId = options.runnerId ?? "runner-a";
  const received: Array<Record<string, unknown>> = [];
  let acks = 0;

  const link = await dialWebSocket({
    url: `${url.replace("http", "ws")}/ws/runner`,
    credential,
  });
  links.push(link);

  const opened = new Promise<void>((resolve) => {
    link.onMessage((raw) => {
      const frame = JSON.parse(raw) as Record<string, unknown>;
      if (frame["type"] === "hello.ok") {
        link.send(JSON.stringify({ type: "reconcile", runner: [], workspaces: [] }));
      }
      if (frame["type"] === "reconcile.ok") resolve();
      if (frame["type"] === "events.ack") acks += 1;
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
        workspaces: [],
      },
    }),
  );

  await opened;
  return {
    received,
    send: (frame: Record<string, unknown>) => link.send(JSON.stringify(frame)),
    async waitForAck(count = 1) {
      const deadline = Date.now() + 4000;
      while (acks < count) {
        if (Date.now() > deadline) throw new Error("timed out waiting for events.ack");
        await Bun.sleep(10);
      }
    },
  };
}

describe("schedule event ingest (§11.5)", () => {
  test("a schedule.created event sent by a runner is accepted and projected", async () => {
    const { db, url, credential } = await start();
    ensureSessionPin(db, {
      sessionId: "session-1",
      ownerId: "user-1",
      workspaceId: "workspace-1",
      runnerId: "runner-a",
    });
    const inbox = new Database(":memory:");
    migrateRunnerDb(inbox);
    const runner = await connectRunner(url, credential, inbox);

    runner.send({
      type: "events",
      events: [
        {
          protocolVersion: PROTOCOL_VERSION,
          eventId: "evt-sched-1",
          runnerId: "runner-a",
          bootId: "boot-1",
          sessionId: "session-1",
          runId: "run-1",
          attemptId: "attempt-1",
          localSequence: 1,
          occurredAt: "2026-10-31T10:00:00.000Z",
          type: "schedule.created",
          payload: {
            toolCallId: "toolu_1",
            cliTaskId: "af5c4b05",
            cron: "58 17 31 10 *",
            recurring: false,
            prompt: "Kiểm tra dung lượng ổ đĩa",
            nextFireAt: 1793444280000,
            timezone: "Asia/Ho_Chi_Minh",
          },
        },
      ],
    });

    // An unknown event type refuses the whole frame, so the ACK is the proof
    // that the new type was accepted.
    await runner.waitForAck();
    expect(listActiveSchedules(db, "session-1")).toHaveLength(1);
  });
});
