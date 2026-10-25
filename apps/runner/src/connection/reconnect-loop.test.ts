import { describe, expect, test } from "bun:test";
import { type Link, type LoopEvent, ReconnectLoop } from "./reconnect-loop.ts";

/**
 * The Runner's connection loop (§6.2, §11.1, §14.3).
 *
 * Sequence on every connect: dial → hello → reconcile → ready. The loop exists
 * because that sequence has to survive the network, and the interesting cases
 * are all the ways it does not complete.
 *
 * Injected `dial` and a fake clock keep this testable without sockets or real
 * waiting — the backoff is the part most likely to be wrong, and sleeping
 * through it in a test is how you stop testing it.
 */

type FakeLink = Link & {
  sent: Array<Record<string, unknown>>;
  /** Deliver a message to the loop as if it came from the server. */
  receive(message: Record<string, unknown>): void;
  /** Simulate the server closing the socket. */
  drop(code?: number): void;
};

function makeLink(): FakeLink {
  const sent: Array<Record<string, unknown>> = [];
  let onMessage: ((raw: string) => void) | undefined;
  let onClose: ((code: number) => void) | undefined;

  return {
    sent,
    send(payload) {
      sent.push(JSON.parse(payload) as Record<string, unknown>);
    },
    close() {},
    onMessage(handler) {
      onMessage = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    receive(message) {
      onMessage?.(JSON.stringify(message));
    },
    drop(code = 1006) {
      onClose?.(code);
    },
  };
}

function harness(
  options: {
    maxAttempts?: number;
    onEventsAcked?: (ack: { attemptId: string; through: number }) => void;
    workspaces?: Array<{ workspaceId: string; path: string }>;
  } = {},
) {
  const links: FakeLink[] = [];
  const events: LoopEvent[] = [];
  const sleeps: number[] = [];
  let attempts = 0;

  const loop = new ReconnectLoop({
    runnerId: "runner-a",
    dial: async () => {
      attempts += 1;
      const link = makeLink();
      links.push(link);
      return link;
    },
    inventory: () => [],
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
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onEvent: (event) => events.push(event),
    ...(options.workspaces === undefined ? {} : { workspaces: options.workspaces }),
    ...(options.onEventsAcked === undefined ? {} : { onEventsAcked: options.onEventsAcked }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });

  return {
    loop,
    links,
    events,
    sleeps,
    get attempts() {
      return attempts;
    },
    get link() {
      return links.at(-1)!;
    },
  };
}

describe("runner reconnect loop", () => {
  test("a connect sends hello, then reconcile, and becomes ready", async () => {
    const h = harness();
    await h.loop.start();

    expect(h.link.sent[0]).toMatchObject({ type: "hello" });

    h.link.receive({ type: "hello.ok", generation: 1, connectionState: "connected" });
    expect(h.link.sent[1]).toMatchObject({ type: "reconcile" });
    // Still not ready: §14.3 requires reconciliation to succeed first.
    expect(h.loop.state).toBe("connecting");

    h.link.receive({ type: "reconcile.ok", ready: true });
    expect(h.loop.state).toBe("ready");
  });

  test("reconcile is only sent after hello.ok, never before", async () => {
    const h = harness();
    await h.loop.start();

    // Sending reconcile first would be rejected by the server as
    // `not_negotiated`, and the loop would retry forever on a bug of its own
    // making.
    expect(h.link.sent.map((m) => m["type"])).toEqual(["hello"]);

    h.link.receive({ type: "hello.ok", generation: 1, connectionState: "connected" });
    expect(h.link.sent.map((m) => m["type"])).toEqual(["hello", "reconcile"]);
  });

  test("a blocked reconciliation does not become ready", async () => {
    const h = harness();
    await h.loop.start();
    h.link.receive({ type: "hello.ok", generation: 1, connectionState: "connected" });

    h.link.receive({ type: "reconcile.blocked", reason: "contradictory_inventory" });

    // The server refused to promote. Pretending to be ready would dispatch work
    // onto state neither side can vouch for.
    expect(h.loop.state).toBe("blocked");
    expect(h.events).toContainEqual({ type: "blocked", reason: "contradictory_inventory" });
  });

  test("a dropped connection reconnects with a growing backoff", async () => {
    const h = harness();
    await h.loop.start();

    // Two drops, because the growth is only visible across consecutive
    // failures; one drop proves a retry happened, not that the delay grew.
    h.link.drop();
    await h.loop.settle();
    h.link.drop();
    await h.loop.settle();

    expect(h.attempts).toBe(3);
    expect(h.sleeps.length).toBe(2);
    // Exponential, and never zero — a zero delay would spin the CPU against a
    // server that is down.
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(100);
    expect(h.sleeps[1]!).toBeGreaterThan(h.sleeps[0]!);
  });

  test("backoff is capped, so a long outage does not push retries hours out", async () => {
    const h = harness();
    await h.loop.start();

    for (let i = 0; i < 12; i += 1) {
      h.link.drop();
      await h.loop.settle();
    }

    // Without a cap the delay doubles past any useful interval and the runner
    // stays offline after the server comes back.
    expect(Math.max(...h.sleeps)).toBeLessThanOrEqual(30_000);
  });

  test("backoff resets after a successful connection", async () => {
    const h = harness();
    await h.loop.start();
    h.link.drop();
    await h.loop.settle();

    // Reconnect, complete the handshake, then drop again.
    h.link.receive({ type: "hello.ok", generation: 2, connectionState: "connected" });
    h.link.receive({ type: "reconcile.ok", ready: true });
    expect(h.loop.state).toBe("ready");

    h.link.drop();
    await h.loop.settle();

    // The delay after a *successful* connection must be small again; keeping the
    // escalated value would punish a healthy runner for an old outage.
    expect(h.sleeps.at(-1)!).toBeLessThanOrEqual(h.sleeps[0]!);
  });

  test("a revocation stops the loop instead of retrying forever", async () => {
    const h = harness();
    await h.loop.start();

    // Close code 4001 is the server's "your credential is dead" signal. Retrying
    // with it hammers the server and never succeeds.
    h.link.drop(4001);
    await h.loop.settle();

    expect(h.loop.state).toBe("revoked");
    expect(h.attempts).toBe(1);
    expect(h.events).toContainEqual({ type: "revoked" });
  });

  test("a superseded socket (4000) stops the loop without retrying", async () => {
    const h = harness();
    await h.loop.start();

    // 4000 means another connection took over this runner's identity. This
    // socket reconnecting would fight its own replacement.
    h.link.drop(4000);
    await h.loop.settle();

    expect(h.loop.state).toBe("superseded");
    expect(h.attempts).toBe(1);
  });

  test("an unexpected error frame is surfaced, not swallowed", async () => {
    const h = harness();
    await h.loop.start();
    h.link.receive({ type: "hello.ok", generation: 1, connectionState: "connected" });

    h.link.receive({ type: "error", reason: "malformed", detail: "bad hello" });

    expect(h.events).toContainEqual({ type: "error", reason: "malformed" });
  });

  test("stop() ends the loop and does not reconnect", async () => {
    const h = harness();
    await h.loop.start();
    const attemptsBefore = h.attempts;

    h.loop.stop();
    h.link.drop();
    await h.loop.settle();

    expect(h.attempts).toBe(attemptsBefore);
    expect(h.loop.state).toBe("stopped");
  });

  test("a command already buffered on the socket is not started after stop()", async () => {
    const handled: unknown[] = [];
    let deliver: ((raw: string) => void) | undefined;

    const loop = new ReconnectLoop({
      runnerId: "runner-a",
      dial: async () => ({
        send() {},
        close() {},
        onMessage(handler) {
          deliver = handler;
        },
        onClose() {},
      }),
      inventory: () => [],
      hello: () => ({ protocolVersion: 1 }),
      sleep: async () => {},
      onEvent: () => {},
      onCommand: async (command) => {
        handled.push(command);
        return { commandId: "cmd-1", attemptId: "attempt-1", accepted: true };
      },
    });

    await loop.start();
    loop.stop();

    // Closing a socket does not discard what the runtime had already queued.
    // The daemon stops the loop, waits for runs to settle, and then closes the
    // database — so a handler invoked after that point starts a run against a
    // closed database, and its events and lock release are lost. `settle()` has
    // already returned by then; it cannot observe work that had not started.
    deliver?.(JSON.stringify({ type: "command", command: { commandId: "cmd-1" } }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(handled).toEqual([]);
  });

  test("start() resolves when the first dial fails, so the daemon can come up", async () => {
    const events: LoopEvent[] = [];
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const loop = new ReconnectLoop({
      runnerId: "runner-a",
      // A refused credential fails the dial before any socket exists.
      dial: async () => {
        throw new Error("websocket failed to open");
      },
      inventory: () => [],
      hello: () => ({ protocolVersion: 1, runnerId: "runner-a" }),
      // Stands in for a real outage: the retry is genuinely pending, not
      // instant. With an instant sleep the loop would resolve for the wrong
      // reason and hide the bug.
      sleep: async () => {
        await blocked;
      },
      onEvent: (event) => events.push(event),
    });

    // Startup must not be hostage to the network. A daemon that only comes up
    // once the control server accepts it can never report why it is not coming
    // up, and can never serve a long outage.
    await loop.start();

    expect(events).toContainEqual({ type: "disconnected", code: 0, retryInMs: 250 });
    expect(loop.state).toBe("connecting");

    release?.();
    loop.stop();
    await loop.settle();
  });

  test("a failed dial keeps retrying after start() has returned", async () => {
    const events: LoopEvent[] = [];
    const sleeps: number[] = [];
    let dials = 0;

    const loop = new ReconnectLoop({
      runnerId: "runner-a",
      dial: async () => {
        dials += 1;
        if (dials < 3) throw new Error("websocket failed to open");
        return makeLink();
      },
      inventory: () => [],
      hello: () => ({ protocolVersion: 1, runnerId: "runner-a" }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onEvent: (event) => events.push(event),
    });

    await loop.start();

    // The retries belong to the loop, not to whoever called start(): the server
    // may come back long after the process started.
    await loop.settle();

    expect(dials).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(events.filter((e) => e.type === "disconnected")).toHaveLength(2);
  });

  test("the reconcile payload carries the runner's inventory", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const link = makeLink();
    const loop = new ReconnectLoop({
      runnerId: "runner-a",
      dial: async () => link,
      inventory: () => [
        { runId: "run-1", attemptId: "attempt-1", state: "running", processAlive: true },
      ],
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
      sleep: async () => {},
      onEvent: () => {},
    });
    void sent;

    await loop.start();
    link.receive({ type: "hello.ok", generation: 1, connectionState: "connected" });

    expect(link.sent[1]).toMatchObject({
      type: "reconcile",
      runner: [{ runId: "run-1", attemptId: "attempt-1", state: "running", processAlive: true }],
    });
  });

  test("a command from the server is handed to the executor", async () => {
    const handled: unknown[] = [];
    const link = makeLink();
    const loop = new ReconnectLoop({
      runnerId: "runner-a",
      dial: async () => link,
      inventory: () => [],
      hello: () => ({ protocolVersion: 1, runnerId: "runner-a" }),
      sleep: async () => {},
      onEvent: () => {},
      onCommand: async (command) => {
        handled.push(command);
        return { commandId: "cmd-1", attemptId: "attempt-1", accepted: true };
      },
    });

    await loop.start();
    link.receive({
      type: "command",
      command: { commandId: "cmd-1", runnerId: "runner-a", kind: "run.start" },
    });

    expect(handled).toEqual([{ commandId: "cmd-1", runnerId: "runner-a", kind: "run.start" }]);
  });

  test("the receipt is sent only after the executor has persisted the command", async () => {
    const order: string[] = [];
    const link = makeLink();
    const loop = new ReconnectLoop({
      runnerId: "runner-a",
      dial: async () => link,
      inventory: () => [],
      hello: () => ({ protocolVersion: 1, runnerId: "runner-a" }),
      sleep: async () => {},
      onEvent: () => {},
      onCommand: async () => {
        // Stands in for the inbox transaction. A receipt that overtakes this is
        // a promise of durability the runner has not made yet (§9.3).
        order.push("persisted");
        return { commandId: "cmd-1", attemptId: "attempt-1", accepted: true };
      },
    });

    await loop.start();
    link.receive({ type: "command", command: { commandId: "cmd-1" } });
    await Bun.sleep(10);

    expect(order).toEqual(["persisted"]);
    expect(link.sent.at(-1)).toEqual({
      type: "command.receipt",
      commandId: "cmd-1",
      attemptId: "attempt-1",
      accepted: true,
    });
  });

  test("a refused command is answered with a receipt carrying the reason", async () => {
    const link = makeLink();
    const loop = new ReconnectLoop({
      runnerId: "runner-a",
      dial: async () => link,
      inventory: () => [],
      hello: () => ({ protocolVersion: 1, runnerId: "runner-a" }),
      sleep: async () => {},
      onEvent: () => {},
      onCommand: async () => ({
        commandId: "cmd-1",
        attemptId: "attempt-1",
        accepted: false,
        reason: "expired",
      }),
    });

    await loop.start();
    link.receive({ type: "command", command: { commandId: "cmd-1" } });
    await Bun.sleep(10);

    // Silence would leave the command pending on the server forever, and the
    // operator would be looking at a run that was never going to start.
    expect(link.sent.at(-1)).toMatchObject({
      type: "command.receipt",
      commandId: "cmd-1",
      accepted: false,
      reason: "expired",
    });
  });

  test("a command frame with no command body is refused without calling the executor", async () => {
    let calls = 0;
    const link = makeLink();
    const loop = new ReconnectLoop({
      runnerId: "runner-a",
      dial: async () => link,
      inventory: () => [],
      hello: () => ({ protocolVersion: 1, runnerId: "runner-a" }),
      sleep: async () => {},
      onEvent: () => {},
      onCommand: async () => {
        calls += 1;
        return { commandId: "", attemptId: "", accepted: true };
      },
    });

    await loop.start();
    link.receive({ type: "command" });
    await Bun.sleep(10);

    expect(calls).toBe(0);
  });
});

describe("event frames", () => {
  test("an events.ack is handed to the ack callback", async () => {
    const acks: Array<{ attemptId: string; through: number }> = [];
    const h = harness({ onEventsAcked: (ack) => acks.push(ack) });
    await h.loop.start();
    h.link.receive({ type: "hello.ok", generation: 1, connectionState: "connected" });
    h.link.receive({ type: "reconcile.ok", ready: true });

    h.link.receive({ type: "events.ack", attemptId: "attempt-1", through: 4 });

    // The loop is transport, not policy: it recognizes the frame and hands it
    // over — the outbox decides what the number means.
    expect(acks).toEqual([{ attemptId: "attempt-1", through: 4 }]);
  });

  test("sendFrame delivers on a ready link and refuses otherwise", async () => {
    const h = harness();
    const loop = h.loop;

    // Before any connection exists there is nothing to carry the frame.
    expect(loop.sendFrame({ type: "events", events: [] })).toBe(false);

    await loop.start();
    h.link.receive({ type: "hello.ok", generation: 1, connectionState: "connected" });
    h.link.receive({ type: "reconcile.ok", ready: true });

    expect(loop.sendFrame({ type: "events", events: [{ eventId: "evt-1" }] })).toBe(true);
    expect(h.link.sent.at(-1)).toEqual({ type: "events", events: [{ eventId: "evt-1" }] });

    // After the link drops the loop is mid-retry: sending into a dead socket
    // would look delivered while the bytes went nowhere. Let the retry chain
    // run its microtasks first — the drop itself is still synchronous.
    h.link.drop(1006);
    await loop.settle();
    expect(loop.state).not.toBe("ready");
    expect(loop.sendFrame({ type: "events", events: [] })).toBe(false);
  });
});

describe("declared workspaces on the wire", () => {
  test("the reconcile frame carries the workspaces the loop was given", async () => {
    const h = harness({ workspaces: [{ workspaceId: "default", path: "/srv/proj" }] });
    await h.loop.start();

    h.link.receive({ type: "hello.ok", generation: 1, connectionState: "connected" });
    expect(h.link.sent[1]).toMatchObject({
      type: "reconcile",
      workspaces: [{ workspaceId: "default", path: "/srv/proj" }],
    });
  });

  test("a loop with no workspaces option sends an empty declaration", async () => {
    const h = harness();
    await h.loop.start();

    h.link.receive({ type: "hello.ok", generation: 1, connectionState: "connected" });
    expect(h.link.sent[1]).toMatchObject({ type: "reconcile", workspaces: [] });
  });
});

describe("declared workspaces on the wire (M4 refresh)", () => {
  test("a thunk is re-evaluated on every reconnect, so branches refresh", async () => {
    let call = 0;
    const declaration = () => {
      call += 1;
      return [
        { workspaceId: "default", path: "/srv/proj", branches: [`b-${call}`] },
      ];
    };
    const h = harness({ workspaces: declaration });

    await h.loop.start();
    h.link.receive({ type: "hello.ok", generation: 1 });
    expect(h.link.sent[1]).toMatchObject({
      type: "reconcile",
      workspaces: [{ workspaceId: "default", path: "/srv/proj", branches: ["b-1"] }],
    });

    h.link.drop();
    await h.loop.start();
    h.link.receive({ type: "hello.ok", generation: 2 });
    expect(h.link.sent[1]).toMatchObject({
      type: "reconcile",
      workspaces: [{ workspaceId: "default", path: "/srv/proj", branches: ["b-2"] }],
    });
    await h.loop.stop();
  });
});
