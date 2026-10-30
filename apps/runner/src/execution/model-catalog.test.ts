import { describe, expect, test } from "bun:test";
import { discoverModels, type ModelCatalogLoad, type ModelCatalogQuery } from "./model-catalog.ts";

/**
 * The boot-time model probe (§5.2).
 *
 * The SDK seam is injected, so these tests never spawn a CLI: what is asserted
 * is the mapping (SDK `ModelInfo` → the wire shape), the failure policy (any
 * error means "no models", never a rejection), and the cleanup (the probe's
 * process is always closed).
 */

type Probe = {
  load: ModelCatalogLoad;
  params: Array<{ prompt: unknown; options: Record<string, unknown> }>;
  closed: number;
  /** Fail the init call instead of answering. */
  fail?: boolean;
  /** Never answer, so the timeout fires. */
  hang?: boolean;
  models?: unknown;
};

function probe(overrides: Partial<Probe> = {}): Probe {
  const state: Probe = {
    params: [],
    closed: 0,
    load: () => ({}) as ModelCatalogQuery,
    ...overrides,
  };
  state.load = (params) => {
    state.params.push({ prompt: params.prompt, options: params.options });
    const query: ModelCatalogQuery = {
      initializationResult: async () => {
        if (state.fail) throw new Error("initialize failed");
        if (state.hang) {
          // Never settles — the timeout is the only way out.
          return new Promise(() => {});
        }
        return { models: state.models };
      },
      close: () => {
        state.closed += 1;
      },
    };
    return query;
  };
  return state;
}

const sdkModels = [
  {
    value: "default",
    resolvedModel: "claude-opus-5",
    displayName: "Default (recommended)",
    description: "Use the default model",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "code",
    description: "Custom Sonnet model",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high"],
  },
];

describe("discoverModels", () => {
  test("maps the SDK catalog onto the wire fields and drops the rest", async () => {
    const state = probe({ models: sdkModels });

    const models = await discoverModels({ cwd: "/srv/proj", load: state.load });

    expect(models).toEqual([
      {
        value: "default",
        displayName: "Default (recommended)",
        description: "Use the default model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        value: "sonnet",
        displayName: "code",
        description: "Custom Sonnet model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
      },
    ]);
  });

  test("probes with the run's own setting sources and cwd", async () => {
    const state = probe({ models: [] });

    await discoverModels({ cwd: "/srv/proj", load: state.load });

    const options = state.params[0]?.options;
    // §7.1: the picker must offer what a run would accept — the same sources.
    expect(options?.["settingSources"]).toEqual(["user", "project", "local"]);
    expect(options?.["cwd"]).toBe("/srv/proj");
    // §20.3: the probe spawns the same embedded CLI a run does.
    expect(typeof options?.["pathToClaudeCodeExecutable"]).toBe("string");
  });

  test("a failed probe reports no models instead of rejecting", async () => {
    const state = probe({ fail: true });

    await expect(discoverModels({ cwd: "/srv", load: state.load })).resolves.toEqual([]);
    expect(state.closed).toBe(1);
  });

  test("a hanging probe is cut off by the timeout and still closed", async () => {
    const state = probe({ hang: true });

    const models = await discoverModels({ cwd: "/srv", load: state.load, timeoutMs: 5 });

    expect(models).toEqual([]);
    expect(state.closed).toBe(1);
  });

  test("a malformed SDK answer is no models, not a crash", async () => {
    for (const models of ["pro", [1], [{ value: "" }]]) {
      const state = probe({ models });
      await expect(discoverModels({ cwd: "/srv", load: state.load })).resolves.toEqual([]);
    }
  });

  test("a query that never was created needs no close", async () => {
    const load: ModelCatalogLoad = () => {
      throw new Error("spawn failed");
    };

    await expect(discoverModels({ cwd: "/srv", load })).resolves.toEqual([]);
  });
});
