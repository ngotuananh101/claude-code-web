import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { migrate } from "@cc-web/control-db";
import { ReconnectLoop } from "../../../runner/src/connection/reconnect-loop.ts";
import { dialWebSocket } from "../../../runner/src/connection/websocket-link.ts";
import { createBetterAuth } from "../auth/better-auth.ts";
import { createServer, type ServerHandle } from "../server.ts";

/**
 * The two halves against each other (§6.2, §14.3).
 *
 * Every other test fakes one side. This one runs the real runner loop against
 * the real control server over a real socket, which is the only way to catch a
 * disagreement between them — a message name, a field, a close code.
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

function startServer(): string {
  const db = new Database(":memory:");
  migrate(db);

  handle = createServer({
    db,
    auth: createBetterAuth(db, { baseURL: "http://control.test", trustedOrigins: [origin] }),
    allowedOrigins: [origin],
    verifyRunnerCredential: (credential) =>
      credential === "cck_valid"
        ? { ok: true, runnerId: "runner-a", ownerId: "user-1" }
        : { ok: false, reason: "unknown" },
  });

  return `ws://127.0.0.1:${handle.server.port}/ws/runner`;
}

const hello = () => ({
  protocolVersion: 1,
  runnerId: "runner-a",
  bootId: "boot-1",
  runnerVersion: "0.0.0",
  sdkVersion: "0.3.309",
  platform: "linux/x64",
  maxConcurrentRuns: 1,
  activeRuns: [],
  eventOffsets: [],
});

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

describe("runner loop against the control server", () => {
  test("a real socket handshake reaches ready through hello and reconcile", async () => {
    const url = startServer();
    const events: string[] = [];

    loop = new ReconnectLoop({
      runnerId: "runner-a",
      dial: () => dialWebSocket({ url, credential: "cck_valid" }),
      hello,
      inventory: () => [],
      sleep: async () => {},
      onEvent: (event) => events.push(event.type),
    });

    await loop.start();
    await waitFor(() => loop!.state === "ready");

    // Both halves agree on the sequence and the message names.
    expect(events).toEqual(["connected", "ready"]);
    expect(handle!.runnerGateway.stateOf("runner-a")).toBe("ready");
  });

  test("an invalid credential never reaches ready", async () => {
    const url = startServer();
    const events: string[] = [];

    loop = new ReconnectLoop({
      runnerId: "runner-a",
      dial: () => dialWebSocket({ url, credential: "cck_wrong", openTimeoutMs: 500 }),
      hello,
      inventory: () => [],
      // A real (if short) sleep: an instant one makes the retry chain spin and
      // starve the event loop, which is a property of the test, not the loop.
      sleep: (ms) => Bun.sleep(Math.min(ms, 20)),
      onEvent: (event) => events.push(event.type),
      maxAttempts: 3,
    });

    await loop.start();
    await waitFor(() => events.length > 0);
    await Bun.sleep(150);

    // The server answers 401 during the upgrade, so the dial itself fails and
    // the loop retries. It must never report a connection it did not get.
    expect(events).not.toContain("connected");
    expect(events).not.toContain("ready");
  });

  test("a second connection supersedes the first and the loop reports it", async () => {
    const url = startServer();

    const first = new ReconnectLoop({
      runnerId: "runner-a",
      dial: () => dialWebSocket({ url, credential: "cck_valid" }),
      hello,
      inventory: () => [],
      sleep: async () => {},
      onEvent: () => {},
    });
    await first.start();
    await waitFor(() => first.state === "ready");

    const events: string[] = [];
    loop = new ReconnectLoop({
      runnerId: "runner-a",
      dial: () => dialWebSocket({ url, credential: "cck_valid" }),
      hello,
      inventory: () => [],
      sleep: async () => {},
      onEvent: (event) => events.push(event.type),
    });
    await loop.start();
    await waitFor(() => loop!.state === "ready");

    // The first loop's socket is now stale. Its next message is refused, and it
    // must stop rather than reconnect and fight its own replacement.
    await waitFor(() => first.state === "superseded");
    expect(first.state).toBe("superseded");

    first.stop();
  });
});
