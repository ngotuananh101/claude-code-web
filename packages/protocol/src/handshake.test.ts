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

  test("an absent capabilities field negotiates as an empty list", () => {
    // A runner that predates the field declares nothing, which is the honest
    // reading: the server must not send it an inspection it cannot answer.
    const result = negotiateHello(hello(), policy);
    expect(result).toMatchObject({ ok: true, capabilities: [] });
  });

  test("a runner declaring capabilities has them returned", () => {
    // `capabilities` is deliberately not one of the forbidden hello fields: it
    // names features, not secrets. Refusing it would make the field unusable.
    const result = negotiateHello(hello({ capabilities: ["inspect"] }), policy);
    expect(result).toMatchObject({ ok: true, capabilities: ["inspect"] });
  });

  test("capabilities that are not an array of non-empty strings are malformed", () => {
    for (const bad of ["inspect", [1], [""], {}, null]) {
      expect(negotiateHello(hello({ capabilities: bad }), policy)).toMatchObject({
        ok: false,
        reason: "malformed",
      });
    }
  });

  test("an absent models field negotiates as an empty list", () => {
    // A pre-discovery runner advertises nothing; the route then falls back to
    // MODEL_IDS instead of treating every hello as malformed.
    const result = negotiateHello(hello(), policy);
    expect(result).toMatchObject({ ok: true, models: [] });
  });

  test("a runner declaring models has them returned", () => {
    const result = negotiateHello(
      hello({
        models: [
          {
            value: "pro",
            displayName: "pro",
            description: "Custom Opus model",
            supportsEffort: true,
            supportedEffortLevels: ["low", "max"],
            // The SDK's own extra fields ride along; only the wire fields survive.
            resolvedModel: "claude-opus-5",
          },
        ],
      }),
      policy,
    );
    expect(result).toMatchObject({
      ok: true,
      models: [
        {
          value: "pro",
          displayName: "pro",
          description: "Custom Opus model",
          supportsEffort: true,
          supportedEffortLevels: ["low", "max"],
        },
      ],
    });
  });

  test("a models field outside the shape is malformed", () => {
    for (const bad of ["pro", [1], [{}], [{ value: "" }], null]) {
      expect(negotiateHello(hello({ models: bad }), policy)).toMatchObject({
        ok: false,
        reason: "malformed",
      });
    }
  });

  test("a hello without the runnerCapabilities field negotiates with an empty catalogue", () => {
    // A runner that predates discovery advertises nothing; the composer and the
    // capabilities dialog read that as "unknown", never as "no commands exist".
    const result = negotiateHello(hello(), policy);
    expect(result).toMatchObject({
      ok: true,
      runnerCapabilities: { commands: [], plugins: [], mcpServers: [], agents: [] },
    });
  });

  test("a hello carrying runnerCapabilities has the catalogue returned", () => {
    const result = negotiateHello(
      hello({
        runnerCapabilities: {
          commands: [
            {
              name: "code-review",
              description: "Review the current diff",
              argumentHint: "[effort]",
              builtin: true,
              aliases: ["review"],
              // SDK/runner internals ride along; only the wire fields survive.
              plugin: "superpowers",
            },
            { name: "brainstorm" },
          ],
          plugins: [
            {
              name: "superpowers",
              version: "1.2.3",
              source: "claude-plugins-official",
              installPath: "/home/runner/.claude/plugins/superpowers",
              scope: "user",
            },
          ],
          mcpServers: [
            {
              name: "browseros-neo",
              status: "connected",
              source: "user",
              command: "node /opt/browseros-neo/dist/index.js",
              tools: ["open", "click"],
            },
            // An unknown status cannot be rendered as a badge; the record is
            // dropped rather than journaled as a status it never had.
            { name: "broken", status: "exploded" },
          ],
          agents: [{ name: "Explore", description: "Read-only search agent", model: "sonnet" }],
        },
      }),
      policy,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runnerCapabilities).toEqual({
      commands: [
        {
          name: "code-review",
          description: "Review the current diff",
          argumentHint: "[effort]",
          builtin: true,
          aliases: ["review"],
        },
        { name: "brainstorm" },
      ],
      plugins: [
        {
          name: "superpowers",
          version: "1.2.3",
          source: "claude-plugins-official",
          installPath: "/home/runner/.claude/plugins/superpowers",
          scope: "user",
        },
      ],
      mcpServers: [
        {
          name: "browseros-neo",
          status: "connected",
          source: "user",
          command: "node /opt/browseros-neo/dist/index.js",
          tools: ["open", "click"],
        },
      ],
      agents: [{ name: "Explore", description: "Read-only search agent", model: "sonnet" }],
    });
  });

  test("an empty runnerCapabilities object negotiates as an empty catalogue", () => {
    const result = negotiateHello(hello({ runnerCapabilities: {} }), policy);
    expect(result).toMatchObject({
      ok: true,
      runnerCapabilities: { commands: [], plugins: [], mcpServers: [], agents: [] },
    });
  });

  test("a runnerCapabilities field outside the shape is malformed", () => {
    for (const bad of [
      "catalogue",
      [],
      { commands: "code-review" },
      { plugins: "superpowers" },
      { mcpServers: { name: "db" } },
      { agents: "Explore" },
      null,
    ]) {
      expect(negotiateHello(hello({ runnerCapabilities: bad }), policy)).toMatchObject({
        ok: false,
        reason: "malformed",
      });
    }
  });

  test("malformed catalogue records are ignored, not fatal", () => {
    // The catalogue is display-only discovery data: one bad entry must not
    // refuse the hello, exactly like an unknown effort level on a model.
    const result = negotiateHello(
      hello({
        runnerCapabilities: {
          commands: [{ name: "compact" }, "junk", { name: "" }],
          plugins: [{ name: "remember" }, null],
          mcpServers: [{ name: "db", status: "failed", env: { API_KEY: "sk-live" } }],
          agents: [{ name: "Explore" }, 7],
        },
      }),
      policy,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runnerCapabilities).toEqual({
      commands: [{ name: "compact" }],
      plugins: [{ name: "remember" }],
      mcpServers: [{ name: "db", status: "failed" }],
      agents: [{ name: "Explore" }],
    });
  });

  test("the catalogue strips env blocks so MCP credentials never reach the journal", () => {
    // §4.1 secret sanitization: the runner redacts before sending, and the
    // server-side parser redacts again by construction — a field that is never
    // copied cannot be persisted, even from a runner that failed to strip it.
    const result = negotiateHello(
      hello({
        runnerCapabilities: {
          mcpServers: [
            {
              name: "db",
              status: "configured",
              source: "project",
              command: "npx mcp-server",
              env: {
                DATABASE_URL: "postgres://user:password@host/db",
                ANTHROPIC_AUTH_TOKEN: "token",
              },
            },
          ],
        },
      }),
      policy,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const server = result.runnerCapabilities.mcpServers[0];
    expect(server).toEqual({
      name: "db",
      status: "configured",
      source: "project",
      command: "npx mcp-server",
    });
    expect(JSON.stringify(result.runnerCapabilities)).not.toContain("password");
    expect(JSON.stringify(result.runnerCapabilities)).not.toContain("token");
  });

  test("feature flags and the catalogue negotiate side by side", () => {
    // `capabilities` (string feature flags) and `runnerCapabilities` (the
    // discovered catalogue) are different fields with different lifetimes; a
    // hello may carry both, and neither may shadow the other.
    const result = negotiateHello(
      hello({
        capabilities: ["inspect", "browse"],
        runnerCapabilities: { commands: [{ name: "compact", builtin: true }] },
      }),
      policy,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capabilities).toEqual(["inspect", "browse"]);
    expect(result.runnerCapabilities.commands).toEqual([{ name: "compact", builtin: true }]);
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
