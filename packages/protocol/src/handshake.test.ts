import { describe, expect, test } from "bun:test";
import { negotiateHello, type ServerPolicy } from "./handshake.ts";

const policy: ServerPolicy = {
  minProtocolVersion: 1,
  maxProtocolVersion: 1,
  maxConcurrentRuns: 4,
};

function hello(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    runnerId: "runner-a",
    bootId: "boot-1",
    runnerVersion: "0.0.0",
    sdkVersion: "0.3.309",
    platform: "linux/x64",
    maxConcurrentRuns: 2,
    activeRuns: [],
    eventOffsets: [],
    ...overrides,
  };
}

describe("hello negotiation", () => {
  test("accepts a hello within the supported range", () => {
    const result = negotiateHello(hello(), policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.negotiation.protocolVersion).toBe(1);
  });

  test("rejects a protocol version the server does not support", () => {
    // §17.4: an unsupported critical command must be rejected, not ignored.
    expect(negotiateHello(hello({ protocolVersion: 2 }), policy)).toMatchObject({
      ok: false,
      reason: "unsupported_protocol",
    });
    expect(negotiateHello(hello({ protocolVersion: 0 }), policy)).toMatchObject({
      ok: false,
      reason: "unsupported_protocol",
    });
  });

  test("negotiates the highest version both sides support", () => {
    const wide: ServerPolicy = {
      minProtocolVersion: 1,
      maxProtocolVersion: 3,
      maxConcurrentRuns: 4,
    };
    const result = negotiateHello(hello({ protocolVersion: 2 }), wide);
    expect(result.ok && result.negotiation.protocolVersion).toBe(3);
  });

  test("rejects a hello that fails shape validation", () => {
    expect(negotiateHello({ protocolVersion: 1 }, policy)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
    expect(negotiateHello(hello({ runnerId: "" }), policy)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
    expect(negotiateHello(hello({ bootId: 42 }), policy)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  test("a hello carrying declared workspaces negotiates and exposes them", () => {
    const workspaces = [{ workspaceId: "default", path: "/srv/proj" }];
    const result = negotiateHello(hello({ workspaces }), policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspaces).toEqual(workspaces);
  });

  test("a hello without the workspaces field negotiates with an empty list", () => {
    const result = negotiateHello(hello(), policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspaces).toEqual([]);
  });

  test("a hello with malformed workspaces is refused as malformed", () => {
    expect(negotiateHello(hello({ workspaces: "default" }), policy)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
    expect(
      negotiateHello(hello({ workspaces: [{ workspaceId: "default" }] }), policy),
    ).toMatchObject({ ok: false, reason: "malformed" });
    expect(
      negotiateHello(hello({ workspaces: [{ workspaceId: "", path: "/srv/proj" }] }), policy),
    ).toMatchObject({ ok: false, reason: "malformed" });
    expect(
      negotiateHello(hello({ workspaces: [{ workspaceId: "w", path: 42 }] }), policy),
    ).toMatchObject({ ok: false, reason: "malformed" });
  });

  test("rejects a hello carrying provider secrets or raw environment", () => {
    // §6.2: the hello payload carries no provider keys, raw env or full config.
    // Accepting one would put a credential into the control journal permanently.
    for (const field of ["env", "apiKey", "ANTHROPIC_AUTH_TOKEN", "config"]) {
      expect(negotiateHello(hello({ [field]: "x" }), policy)).toMatchObject({
        ok: false,
        reason: "forbidden_field",
      });
    }
  });

  test("clamps the runner's advertised capacity to server policy", () => {
    const result = negotiateHello(hello({ maxConcurrentRuns: 99 }), policy);
    expect(result.ok && result.negotiation.policy.maxConcurrentRuns).toBe(4);
  });

  test("a zero-capacity runner is accepted, not rejected", () => {
    // §11.1: connection health and capacity are separate. A connected runner
    // with no capacity simply receives no new runs.
    const result = negotiateHello(hello({ maxConcurrentRuns: 0 }), policy);
    expect(result.ok && result.negotiation.policy.maxConcurrentRuns).toBe(0);
  });

  test("a runner never starts in ready state after negotiation", () => {
    // §6.2: "Runner chỉ chuyển sang ready sau reconciliation." Connected is not ready.
    const result = negotiateHello(hello(), policy);
    expect(result.ok && result.connectionState).toBe("connected");
  });

  test("reports why a malformed field failed so the operator can fix it", () => {
    const result = negotiateHello(hello({ maxConcurrentRuns: "many" }), policy);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("maxConcurrentRuns");
  });
});
