import { beforeEach, describe, expect, test } from "bun:test";
import { RunRegistry } from "@cc-web/protocol";
import type { ServerWebSocket } from "bun";
import { RunnerGateway, type RunnerSocketData } from "./runner-gateway.ts";

/**
 * The runner gateway: one WSS route, credentials in a header, generation fencing
 * on every message, and reconciliation before `ready`.
 */

type Sent = { type: string; [key: string]: unknown };

function makeSocket(): {
  socket: ServerWebSocket<RunnerSocketData>;
  sent: Sent[];
  closed: number[];
} {
  const sent: Sent[] = [];
  const closed: number[] = [];

  const socket = {
    data: { connectionId: "", generation: 0, runnerId: "", authenticated: false },
    send(payload: string | Uint8Array) {
      sent.push(JSON.parse(String(payload)));
      return 1;
    },
    close(code?: number) {
      closed.push(code ?? 1000);
    },
  } as unknown as ServerWebSocket<RunnerSocketData>;

  return { socket, sent, closed };
}

const hello = {
  protocolVersion: 1,
  runnerId: "runner-a",
  bootId: "boot-1",
  runnerVersion: "0.0.0",
  sdkVersion: "0.3.309",
  platform: "linux/x64",
  maxConcurrentRuns: 1,
  activeRuns: [],
  eventOffsets: [],
};

describe("runner gateway", () => {
  let gateway: RunnerGateway;

  beforeEach(() => {
    gateway = new RunnerGateway({
      policy: { minProtocolVersion: 1, maxProtocolVersion: 1, maxConcurrentRuns: 4 },
      verifyCredential: (credential) =>
        credential === "cck_valid"
          ? { ok: true, runnerId: "runner-a", ownerId: "owner-1" }
          : { ok: false, reason: "unknown" },
    });
  });

  test("rejects a connection with no credential before accepting any message", () => {
    const { socket, sent, closed } = makeSocket();
    gateway.handleOpen(socket, {});

    expect(sent).toEqual([{ type: "error", reason: "unauthorized" }]);
    expect(closed).toEqual([1008]);
  });

  test("rejects a connection whose credential does not verify", () => {
    const { socket, sent, closed } = makeSocket();
    gateway.handleOpen(socket, { authorization: "Bearer cck_bogus" });

    expect(sent[0]).toMatchObject({ type: "error", reason: "unauthorized" });
    expect(closed).toEqual([1008]);
  });

  test("authenticates from a header, never from the URL", () => {
    const { socket, sent } = makeSocket();
    // §6.2: the credential travels in a supported header, not the URL, so it
    // does not land in access logs.
    gateway.handleOpen(socket, { authorization: "Bearer cck_valid" });

    expect(sent).toEqual([]);
    expect(socket.data.authenticated).toBe(true);
    expect(socket.data.runnerId).toBe("runner-a");
    expect(socket.data.generation).toBe(1);
  });

  test("a hello is answered with the negotiated policy and state connected", () => {
    const { socket, sent } = makeSocket();
    gateway.handleOpen(socket, { authorization: "Bearer cck_valid" });
    gateway.handleMessage(socket, JSON.stringify({ type: "hello", hello }));

    expect(sent).toEqual([
      {
        type: "hello.ok",
        negotiation: { protocolVersion: 1, policy: { maxConcurrentRuns: 1 } },
        generation: 1,
        connectionState: "connected",
      },
    ]);
  });

  test("reconciliation follows the hello and promotes the runner to ready", () => {
    const { socket, sent } = makeSocket();
    gateway.handleOpen(socket, { authorization: "Bearer cck_valid" });
    gateway.handleMessage(socket, JSON.stringify({ type: "hello", hello }));
    gateway.handleMessage(socket, JSON.stringify({ type: "reconcile", runner: [] }));

    // The runner is told it is ready. The actions are the server's to apply,
    // not the runner's to execute (§14.3) — they are not echoed back.
    expect(sent[1]).toEqual({ type: "reconcile.ok", ready: true });
    expect(gateway.stateOf("runner-a")).toBe("ready");
  });

  test("reconciliation applies its actions to the server's run state, not to the runner", () => {
    const runs = new RunRegistry();
    runs.createRun({
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      runnerId: "runner-a",
    });

    const gateway = new RunnerGateway({
      policy: { minProtocolVersion: 1, maxProtocolVersion: 1, maxConcurrentRuns: 4 },
      verifyCredential: () => ({ ok: true, runnerId: "runner-a", ownerId: "owner-1" }),
      runs,
    });

    const { socket } = makeSocket();
    gateway.handleOpen(socket, { authorization: "Bearer cck_valid" });
    gateway.handleMessage(socket, JSON.stringify({ type: "hello", hello }));
    gateway.handleMessage(
      socket,
      JSON.stringify({
        type: "reconcile",
        runner: [{ runId: "run-1", attemptId: "attempt-1", state: "completed" }],
      }),
    );

    // The runner's evidence becomes the server's observed outcome.
    expect(runs.get("run-1")?.observedState).toBe("completed");
    // And the session is freed, because the run is genuinely finished.
    expect(runs.activeRunFor("session-1")).toBeUndefined();
  });

  test("a run whose process vanished on reconnect is interrupted, and never silently resumed", () => {
    const runs = new RunRegistry();
    runs.createRun({
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      runnerId: "runner-a",
    });

    const gateway = new RunnerGateway({
      policy: { minProtocolVersion: 1, maxProtocolVersion: 1, maxConcurrentRuns: 4 },
      verifyCredential: () => ({ ok: true, runnerId: "runner-a", ownerId: "owner-1" }),
      runs,
    });

    const { socket } = makeSocket();
    gateway.handleOpen(socket, { authorization: "Bearer cck_valid" });
    gateway.handleMessage(socket, JSON.stringify({ type: "hello", hello }));
    gateway.handleMessage(socket, JSON.stringify({ type: "reconcile", runner: [] }));

    // The server's own inventory is what gets interrupted: reconcile() is fed
    // from the registry, not from the runner's message.
    expect(runs.get("run-1")?.observedState).toBe("interrupted");
    expect(gateway.stateOf("runner-a")).toBe("ready");
  });

  test("one runner reconnecting never touches another runner's run", () => {
    const runs = new RunRegistry();
    runs.createRun({
      runId: "run-a",
      attemptId: "attempt-a",
      sessionId: "session-a",
      runnerId: "runner-a",
    });
    runs.createRun({
      runId: "run-b",
      attemptId: "attempt-b",
      sessionId: "session-b",
      runnerId: "runner-b",
    });

    const gateway = new RunnerGateway({
      policy: { minProtocolVersion: 1, maxProtocolVersion: 1, maxConcurrentRuns: 4 },
      verifyCredential: () => ({ ok: true, runnerId: "runner-a", ownerId: "owner-1" }),
      runs,
    });

    const { socket } = makeSocket();
    gateway.handleOpen(socket, { authorization: "Bearer cck_valid" });
    gateway.handleMessage(socket, JSON.stringify({ type: "hello", hello }));
    // Runner A reconnects with nothing alive; runner B's socket is untouched.
    gateway.handleMessage(socket, JSON.stringify({ type: "reconcile", runner: [] }));

    expect(runs.get("run-a")?.observedState).toBe("interrupted");
    expect(runs.get("run-b")?.observedState).toBeUndefined();
  });

  test("a contradictory inventory blocks promotion and is reported", () => {
    const { socket, sent } = makeSocket();
    gateway.handleOpen(socket, { authorization: "Bearer cck_valid" });
    gateway.handleMessage(socket, JSON.stringify({ type: "hello", hello }));
    gateway.handleMessage(
      socket,
      JSON.stringify({
        type: "reconcile",
        runner: [
          { runId: "run-1", attemptId: "attempt-1", state: "running", processAlive: true },
          { runId: "run-1", attemptId: "attempt-1", state: "completed" },
        ],
      }),
    );

    expect(sent[1]).toMatchObject({ type: "reconcile.blocked", reason: "contradictory_inventory" });
    expect(gateway.stateOf("runner-a")).not.toBe("ready");
  });

  test("a second connection supersedes the first and closes it immediately", () => {
    const first = makeSocket();
    gateway.handleOpen(first.socket, { authorization: "Bearer cck_valid" });

    const second = makeSocket();
    gateway.handleOpen(second.socket, { authorization: "Bearer cck_valid" });

    // §6.3: exactly one generation is current. The old socket is closed at once
    // rather than on its next message — a stale runner that never speaks again
    // would otherwise stay connected believing it is ready.
    expect(first.sent).toEqual([{ type: "error", reason: "stale_generation" }]);
    expect(first.closed).toEqual([4000]);
    expect(second.closed).toEqual([]);
  });

  test("a stale socket that speaks anyway is fenced", () => {
    const first = makeSocket();
    gateway.handleOpen(first.socket, { authorization: "Bearer cck_valid" });

    const second = makeSocket();
    gateway.handleOpen(second.socket, { authorization: "Bearer cck_valid" });

    // The socket was closed, but a message already in flight must still be
    // refused on its merits rather than processed because the close raced.
    const stale = gateway.handleMessage(first.socket, JSON.stringify({ type: "hello", hello }));

    expect(stale).toEqual({ ok: false, reason: "stale_generation" });
    expect(gateway.stateOf("runner-a")).not.toBe("ready");
  });

  test("messages before hello are refused", () => {
    const { socket, sent } = makeSocket();
    gateway.handleOpen(socket, { authorization: "Bearer cck_valid" });
    const result = gateway.handleMessage(socket, JSON.stringify({ type: "event", event: {} }));

    expect(result).toEqual({ ok: false, reason: "not_negotiated" });
    expect(sent[0]).toMatchObject({ type: "error", reason: "not_negotiated" });
  });

  test("malformed JSON closes the connection rather than being ignored", () => {
    const { socket, closed } = makeSocket();
    gateway.handleOpen(socket, { authorization: "Bearer cck_valid" });
    const result = gateway.handleMessage(socket, "{not json");

    expect(result).toEqual({ ok: false, reason: "malformed" });
    expect(closed).toEqual([1003]);
  });

  test("a revoked runner is disconnected with a policy code", () => {
    const { socket, sent, closed } = makeSocket();
    gateway.handleOpen(socket, { authorization: "Bearer cck_valid" });
    gateway.revoke("runner-a");

    expect(gateway.stateOf("runner-a")).toBe("revoked");
    expect(sent.at(-1)).toMatchObject({ type: "error", reason: "revoked" });
    expect(closed.at(-1)).toBe(4001);
  });

  test("a revoked runner cannot reconnect", () => {
    gateway.revoke("runner-a");
    const { socket, closed } = makeSocket();
    gateway.handleOpen(socket, { authorization: "Bearer cck_valid" });

    expect(closed).toEqual([4001]);
  });

  test("closing a stale socket does not evict the current connection", () => {
    const first = makeSocket();
    gateway.handleOpen(first.socket, { authorization: "Bearer cck_valid" });
    const second = makeSocket();
    gateway.handleOpen(second.socket, { authorization: "Bearer cck_valid" });

    gateway.handleClose(first.socket);

    expect(gateway.stateOf("runner-a")).not.toBe("offline");
    expect(gateway.stateOf("runner-a")).toBe("connected");
  });
});
