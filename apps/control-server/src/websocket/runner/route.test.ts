import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { runnerSocketData, runnerWebSocket, upgradeRunner } from "./route.ts";
import { RunnerGateway, type RunnerSocketData } from "./runner-gateway.ts";

/**
 * The route is exercised over a real socket: Bun.serve on an ephemeral port and
 * Bun's WebSocket client. A mocked socket would prove the handler wiring but not
 * the thing that actually breaks in production — the upgrade, the headers, and
 * the close codes.
 */

let server: Server<RunnerSocketData> | undefined;

function start() {
  const gateway = new RunnerGateway({
    policy: { minProtocolVersion: 1, maxProtocolVersion: 1, maxConcurrentRuns: 4 },
    verifyCredential: (credential) =>
      credential === "cck_valid"
        ? { ok: true, runnerId: "runner-a", ownerId: "owner-1" }
        : { ok: false, reason: "unknown" },
  });

  server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname !== "/ws/runner") return new Response("not found", { status: 404 });
      const upgraded = upgradeRunner(request, srv, gateway);
      return upgraded.ok
        ? (undefined as unknown as Response)
        : new Response("refused", { status: upgraded.status });
    },
    websocket: runnerWebSocket(gateway),
  });

  return { gateway, url: `ws://127.0.0.1:${server.port}/ws/runner` };
}

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

type Client = {
  messages: Array<Record<string, unknown>>;
  closed: Promise<number>;
  send(message: unknown): void;
  close(): void;
};

async function connect(url: string, headers: Record<string, string>): Promise<Client> {
  const messages: Array<Record<string, unknown>> = [];
  const socket = new WebSocket(url, { headers } as never);

  const closed = new Promise<number>((resolve) => {
    socket.addEventListener("close", (event) => resolve((event as CloseEvent).code));
  });

  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("connect failed")));
  });

  return {
    messages,
    closed,
    send: (message) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  };
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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

describe("runner websocket route", () => {
  test("a valid credential negotiates hello and reaches ready over a real socket", async () => {
    const { gateway, url } = start();

    const client = await connect(url, { Authorization: "Bearer cck_valid" });
    client.send({ type: "hello", hello });
    await waitFor(() => client.messages.length >= 1);

    expect(client.messages[0]).toMatchObject({
      type: "hello.ok",
      connectionState: "connected",
      generation: 1,
    });
    expect(gateway.stateOf("runner-a")).toBe("connected");

    client.send({ type: "reconcile", runner: [] });
    await waitFor(() => client.messages.length >= 2);

    expect(client.messages[1]).toMatchObject({ type: "reconcile.ok", ready: true });
    expect(gateway.stateOf("runner-a")).toBe("ready");

    client.close();
  });

  test("a connection without a credential is refused during the upgrade", async () => {
    const { url } = start();

    // No upgrade happens, so the client sees an ordinary HTTP failure rather
    // than an established socket that is then closed.
    const response = await fetch(url.replace("ws://", "http://"));
    expect(response.status).toBe(401);
  });

  test("a superseded socket receives stale_generation and is closed with the policy code", async () => {
    const { gateway, url } = start();

    const first = await connect(url, { Authorization: "Bearer cck_valid" });
    first.send({ type: "hello", hello });
    await waitFor(() => first.messages.length >= 1);

    const second = await connect(url, { Authorization: "Bearer cck_valid" });
    second.send({ type: "hello", hello });
    await waitFor(() => second.messages.length >= 1);

    expect(gateway.stateOf("runner-a")).toBe("connected");

    // §6.3: the old socket still exists in the network but no longer owns state.
    first.send({ type: "reconcile", runner: [] });
    await waitFor(() => first.messages.length >= 2);

    expect(first.messages[1]).toMatchObject({ type: "error", reason: "stale_generation" });
    expect(await first.closed).toBe(4000);

    second.close();
  });

  test("a revoked runner is closed with the revocation code and cannot come back", async () => {
    const { gateway, url } = start();

    const first = await connect(url, { Authorization: "Bearer cck_valid" });
    first.send({ type: "hello", hello });
    await waitFor(() => first.messages.length >= 1);

    gateway.revoke("runner-a");
    expect(await first.closed).toBe(4001);

    const response = await fetch(url.replace("ws://", "http://"), {
      headers: { Authorization: "Bearer cck_valid" },
    });
    expect(response.status).toBe(401);
  });

  test("the credential is never accepted from the query string", async () => {
    const { url } = start();

    const response = await fetch(`${url.replace("ws://", "http://")}?token=cck_valid`);
    expect(response.status).toBe(401);
  });
});

describe("runner socket data", () => {
  test("an upgrade seeds authenticated:false so a pre-open message cannot be trusted", () => {
    // The default must fail closed: if the gateway never runs handleOpen the
    // message handler must still refuse.
    expect(runnerSocketData()).toEqual({
      connectionId: "",
      generation: 0,
      runnerId: "",
      authenticated: false,
    });
  });
});
