import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  CommandOutbox,
  issueRunnerCredential,
  migrate,
  upsertApprovalRequested,
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
 * POST /api/approvals/:id/decision (§13.1, §17.1).
 *
 * The owner answers a card in the journal; the route records the decision and
 * the `approval.respond` command in one transaction, then drains the holding
 * runner. The runner on the other side is the real handshake, so the happy
 * path proves the decision actually reaches the inbox that parked the gate.
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

const APPROVAL = {
  approvalId: "apr-1",
  sessionId: "session-1",
  runId: "run-1",
  attemptId: "attempt-1",
  runnerId: "runner-a",
  kind: "tool_permission" as const,
  toolName: "Bash",
  inputHash: "hash-1",
  inputSummary: "ls -la",
  expiresAt: Date.now() + 60_000,
};

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

async function connectRunner(url: string, credential: string, inbox: Database) {
  const received: Array<Record<string, unknown>> = [];

  link = await dialWebSocket({
    url: `${url.replace("http", "ws")}/ws/runner`,
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
  return { received };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

function decide(
  url: string,
  cookie: string,
  approvalId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return fetch(`${url}/api/approvals/${approvalId}/decision`, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/approvals/:id/decision", () => {
  test("an allow enqueues approval.respond for the holding runner and drains it", async () => {
    const { db, url, cookie, credential } = await start();
    const inbox = new Database(":memory:");
    migrateRunnerDb(inbox);
    const runner = await connectRunner(url, credential, inbox);
    await waitFor(() => handle!.runnerGateway.stateOf("runner-a") === "ready");
    upsertApprovalRequested(db, APPROVAL);

    const response = await decide(url, cookie, "apr-1", {
      decision: "allow",
      answers: { "Chạy migration?": "Có" },
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ approvalId: "apr-1", state: "decided" });

    // The decision row and the outbox command committed together.
    const outboxRow = db
      .query(
        "SELECT runner_id, kind, payload, attempt_id FROM command_outbox WHERE kind = 'approval.respond'",
      )
      .get() as { runner_id: string; kind: string; payload: string; attempt_id: string };
    expect(outboxRow.runner_id).toBe("runner-a");
    expect(outboxRow.attempt_id).toBe("attempt-1");
    expect(JSON.parse(outboxRow.payload)).toEqual({
      approvalId: "apr-1",
      decision: "allow",
      answers: { "Chạy migration?": "Có" },
      inputHash: "hash-1",
    });

    // And the drain put it on the wire: the runner's inbox accepted it.
    await waitFor(() => runner.received.some((command) => command["kind"] === "approval.respond"));
    await waitFor(() =>
      (inbox.query("SELECT kind FROM command_inbox").all() as Array<{ kind: string }>).some(
        (row) => row.kind === "approval.respond",
      ),
    );
  });

  test("a second decision on a decided approval answers 409", async () => {
    const { db, url, cookie } = await start();
    upsertApprovalRequested(db, APPROVAL);

    const first = await decide(url, cookie, "apr-1", { decision: "deny" });
    expect(first.status).toBe(202);

    const second = await decide(url, cookie, "apr-1", { decision: "allow" });
    expect(second.status).toBe(409);
  });

  test("an unknown approval answers 404", async () => {
    const { url, cookie } = await start();

    const response = await decide(url, cookie, "apr-nobody", { decision: "allow" });

    expect(response.status).toBe(404);
  });

  test("a body without a valid decision is a bad request", async () => {
    const { url, cookie } = await start();

    expect((await decide(url, cookie, "apr-1", {})).status).toBe(400);
    expect((await decide(url, cookie, "apr-1", { decision: "maybe" })).status).toBe(400);
    expect((await decide(url, cookie, "apr-1", { decision: "allow", answers: "yes" })).status).toBe(
      400,
    );
  });

  test("a foreign Origin is refused before the cookie is read", async () => {
    const { url, cookie } = await start();

    const response = await fetch(`${url}/api/approvals/apr-1/decision`, {
      method: "POST",
      headers: { Origin: "https://evil.example.test", Cookie: cookie },
    });
    expect(response.status).toBe(403);
  });

  test("without a session cookie the answer is the one 401", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/api/approvals/apr-1/decision`, {
      method: "POST",
      headers: { Origin: origin },
    });
    expect(response.status).toBe(401);
  });
});
