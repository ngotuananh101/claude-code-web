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

  test("reconciliation's abandon_approval reaches the approval projection", () => {
    const runs = new RunRegistry();
    runs.createRun({
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      runnerId: "runner-a",
    });
    runs.markWaitingForApproval("run-1", "attempt-1");

    // The runner reports the gate dead while the server still says waiting:
    // reconcile() abandons the approval and interrupts the run. The abandoned
    // approvals are the projection's to close — the gateway hands them over.
    const abandoned: Array<{ runId: string; attemptId: string }> = [];
    const gateway = new RunnerGateway({
      policy: { minProtocolVersion: 1, maxProtocolVersion: 1, maxConcurrentRuns: 4 },
      verifyCredential: () => ({ ok: true, runnerId: "runner-a", ownerId: "owner-1" }),
      runs,
      onAbandonApproval: (_runnerId, action) => {
        abandoned.push(action);
      },
    });

    const { socket } = makeSocket();
    gateway.handleOpen(socket, { authorization: "Bearer cck_valid" });
    gateway.handleMessage(socket, JSON.stringify({ type: "hello", hello }));
    gateway.handleMessage(
      socket,
      JSON.stringify({
        type: "reconcile",
        runner: [
          { runId: "run-1", attemptId: "attempt-1", state: "running", processAlive: true, approvalsAlive: false },
        ],
      }),
    );

    expect(abandoned).toEqual([{ runId: "run-1", attemptId: "attempt-1" }]);
    expect(runs.get("run-1")?.observedState).toBe("interrupted");
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

describe("event ingestion", () => {
  /** Drive one socket through hello + reconcile so it is ready. */
  function readySocket(gateway: RunnerGateway) {
    const made = makeSocket();
    gateway.handleOpen(made.socket, { authorization: "Bearer cck_valid" });
    gateway.handleMessage(made.socket, JSON.stringify({ type: "hello", hello }));
    gateway.handleMessage(made.socket, JSON.stringify({ type: "reconcile", runner: [] }));
    return made;
  }

  function wireframe(sequence: number, eventId: string) {
    return {
      protocolVersion: 1,
      eventId,
      runnerId: "runner-a",
      bootId: "boot-1",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      localSequence: sequence,
      occurredAt: "2026-10-24T00:00:00.000Z",
      type: "run.started",
      payload: { commandId: "cmd-1" },
    };
  }

  test("a ready runner's events reach the journal hook and are acknowledged", () => {
    const seen: Array<{ runnerId: string; count: number }> = [];
    const gateway = new RunnerGateway({
      policy: { minProtocolVersion: 1, maxProtocolVersion: 1, maxConcurrentRuns: 4 },
      verifyCredential: () => ({ ok: true, runnerId: "runner-a", ownerId: "owner-1" }),
      onEvents: (runnerId, events) => {
        seen.push({ runnerId, count: events.length });
        return [{ attemptId: "attempt-1", through: 2 }];
      },
    });

    const { socket, sent } = readySocket(gateway);
    const result = gateway.handleMessage(
      socket,
      JSON.stringify({ type: "events", events: [wireframe(1, "evt-1"), wireframe(2, "evt-2")] }),
    );

    expect(result).toEqual({ ok: true });
    // The hook receives the authenticated identity's events, not a claim in
    // the payload it might have wanted to trust.
    expect(seen).toEqual([{ runnerId: "runner-a", count: 2 }]);
    expect(sent.at(-1)).toEqual({ type: "events.ack", attemptId: "attempt-1", through: 2 });
  });

  test("a batch spanning two attempts is acknowledged per attempt", () => {
    const gateway = new RunnerGateway({
      policy: { minProtocolVersion: 1, maxProtocolVersion: 1, maxConcurrentRuns: 4 },
      verifyCredential: () => ({ ok: true, runnerId: "runner-a", ownerId: "owner-1" }),
      onEvents: () => [
        { attemptId: "attempt-1", through: 1 },
        { attemptId: "attempt-2", through: 3 },
      ],
    });

    const { socket, sent } = readySocket(gateway);
    gateway.handleMessage(
      socket,
      JSON.stringify({ type: "events", events: [wireframe(1, "evt-1")] }),
    );

    // §12.2: the watermark is per attempt — one attempt's gap must not hold
    // another attempt's acknowledgements hostage.
    expect(sent.filter((f) => f.type === "events.ack")).toEqual([
      { type: "events.ack", attemptId: "attempt-1", through: 1 },
      { type: "events.ack", attemptId: "attempt-2", through: 3 },
    ]);
  });

  test("events before reconciliation are refused, not journaled", () => {
    let reached = 0;
    const gateway = new RunnerGateway({
      policy: { minProtocolVersion: 1, maxProtocolVersion: 1, maxConcurrentRuns: 4 },
      verifyCredential: () => ({ ok: true, runnerId: "runner-a", ownerId: "owner-1" }),
      onEvents: () => {
        reached += 1;
        return [];
      },
    });

    const made = makeSocket();
    gateway.handleOpen(made.socket, { authorization: "Bearer cck_valid" });
    gateway.handleMessage(made.socket, JSON.stringify({ type: "hello", hello }));
    // Still `connected`, not `ready`: the same stance as dispatch — a runner
    // whose reconciliation has not succeeded cannot vouch for its events.
    const result = gateway.handleMessage(
      made.socket,
      JSON.stringify({ type: "events", events: [wireframe(1, "evt-1")] }),
    );

    expect(result).toEqual({ ok: false, reason: "not_ready" });
    expect(made.sent.at(-1)).toMatchObject({ type: "error", reason: "not_ready" });
    expect(reached).toBe(0);
  });

  test("an event claiming another runner's identity is refused and never journaled", () => {
    let reached = 0;
    const gateway = new RunnerGateway({
      policy: { minProtocolVersion: 1, maxProtocolVersion: 1, maxConcurrentRuns: 4 },
      verifyCredential: () => ({ ok: true, runnerId: "runner-a", ownerId: "owner-1" }),
      onEvents: () => {
        reached += 1;
        return [];
      },
    });

    const { socket, sent } = readySocket(gateway);
    const impostor = { ...wireframe(1, "evt-1"), runnerId: "runner-b" };
    const result = gateway.handleMessage(
      socket,
      JSON.stringify({ type: "events", events: [impostor] }),
    );

    // §19.2: the credential authenticated runner-a; a payload claiming
    // runner-b is a journal-writing attempt under someone else's name.
    expect(result).toEqual({ ok: false, reason: "malformed" });
    expect(sent.at(-1)).toMatchObject({ type: "error", reason: "malformed_event" });
    expect(reached).toBe(0);
  });

  test("an event with an unknown type string is refused and never journaled", () => {
    let reached = 0;
    const gateway = new RunnerGateway({
      policy: { minProtocolVersion: 1, maxProtocolVersion: 1, maxConcurrentRuns: 4 },
      verifyCredential: () => ({ ok: true, runnerId: "runner-a", ownerId: "owner-1" }),
      onEvents: () => {
        reached += 1;
        return [];
      },
    });

    const { socket, sent } = readySocket(gateway);
    const invented = { ...wireframe(1, "evt-1"), type: "run.exploded" };
    const result = gateway.handleMessage(
      socket,
      JSON.stringify({ type: "events", events: [invented] }),
    );

    // The journal is durable and public (§12.3): a type nobody defines would
    // be stored forever and every reader would have to tolerate it.
    expect(result).toEqual({ ok: false, reason: "malformed" });
    expect(sent.at(-1)).toMatchObject({ type: "error", reason: "malformed_event" });
    expect(reached).toBe(0);
  });

  test("an events frame whose body is not an array is refused", () => {
    const gateway = new RunnerGateway({
      policy: { minProtocolVersion: 1, maxProtocolVersion: 1, maxConcurrentRuns: 4 },
      verifyCredential: () => ({ ok: true, runnerId: "runner-a", ownerId: "owner-1" }),
      onEvents: () => [],
    });

    const { socket } = readySocket(gateway);
    const result = gateway.handleMessage(
      socket,
      JSON.stringify({ type: "events", events: "nope" }),
    );

    expect(result).toEqual({ ok: false, reason: "malformed" });
  });
});
