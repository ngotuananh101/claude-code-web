import { describe, expect, test } from "bun:test";
import { BrowserGateway, type BrowserSocket, type BrowserSocketData } from "./browser-gateway.ts";

function makeSocket(userId: string) {
  const sent: Array<Record<string, unknown>> = [];
  const socket = {
    data: { userId, authenticated: true, subscriptions: new Set<string>() } as BrowserSocketData,
    send(payload: string) {
      sent.push(JSON.parse(payload) as Record<string, unknown>);
      return 1;
    },
    close() {},
  } as unknown as BrowserSocket;
  return { socket, sent };
}

function gateway() {
  return new BrowserGateway({
    resolveSession: async () => null,
    allowedOrigins: [],
    resolveOwner: () => undefined,
    readReplay: () => [],
    replayBounds: () => ({ watermark: 0, earliest: 0 }),
  });
}

describe("BrowserGateway.notify", () => {
  test("sends a notification frame to the user's sockets only, with the event type separate", () => {
    const gw = gateway();
    const a = makeSocket("user-1");
    const b = makeSocket("user-2");
    gw.register(a.socket);
    gw.register(b.socket);
    gw.notify("user-1", {
      eventId: "evt-1",
      type: "approval.requested",
      sessionId: "session-1",
      toolName: "Bash",
    });
    expect(a.sent.length).toBe(1);
    expect(a.sent[0]!["type"]).toBe("notification");
    expect(a.sent[0]!["notificationType"]).toBe("approval.requested");
    expect(a.sent[0]!["eventId"]).toBe("evt-1");
    expect(b.sent.length).toBe(0);
  });

  test("no sockets for the user means no crash", () => {
    const gw = gateway();
    gw.notify("nobody", { eventId: "evt-1", type: "run.finished", sessionId: "s" });
  });
});
