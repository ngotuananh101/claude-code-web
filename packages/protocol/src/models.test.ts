import { describe, expect, test } from "bun:test";
import { EFFORT_LEVELS, MODEL_IDS, type ModelId, parseRunnerModels } from "./models.ts";

describe("MODEL_IDS", () => {
  // §8.1 fixes the model names the protocol carries; this pin is the spec, not
  // a change detector — the route's validation set and the composer's label
  // map both derive from this one list.
  test("is exactly the §8.1 list", () => {
    expect([...MODEL_IDS]).toEqual(["sonnet", "opus", "haiku"]);
  });

  test("every member is a usable ModelId", () => {
    const labels: Record<ModelId, string> = {
      sonnet: "Sonnet",
      opus: "Opus",
      haiku: "Haiku",
    };
    for (const model of MODEL_IDS) expect(labels[model]).toBeTruthy();
  });
});

describe("EFFORT_LEVELS", () => {
  // The five levels Claude Code speaks. `max` is session-only there, so it
  // cannot be left out of the wire format just because it never persists.
  test("is exactly Claude Code's effort list", () => {
    expect([...EFFORT_LEVELS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("parseRunnerModels", () => {
  const full = {
    value: "opus",
    resolvedModel: "claude-opus-5",
    displayName: "pro",
    description: "Custom Opus model",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high", "max"],
    supportsAdaptiveThinking: true,
  };

  test("an absent field is an empty list, not an error", () => {
    // A runner that predates discovery advertises nothing; the route falls
    // back to MODEL_IDS rather than treating the hello as malformed.
    expect(parseRunnerModels(undefined)).toEqual([]);
  });

  test("keeps the wire fields and drops the rest", () => {
    expect(parseRunnerModels([full])).toEqual([
      {
        value: "opus",
        displayName: "pro",
        description: "Custom Opus model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high", "max"],
      },
    ]);
  });

  test("a missing display name falls back to the value", () => {
    expect(parseRunnerModels([{ value: "code" }])?.[0]).toMatchObject({
      value: "code",
      displayName: "code",
      description: "",
      supportsEffort: false,
      supportedEffortLevels: [],
    });
  });

  test("an unknown effort level is dropped, not fatal", () => {
    // A newer Claude Code naming a level this server does not implement must
    // cost only that level — not the model, and not the whole hello.
    const parsed = parseRunnerModels([{ value: "x", supportedEffortLevels: ["low", "extreme"] }]);
    expect(parsed?.[0]?.supportedEffortLevels).toEqual(["low"]);
  });

  test("duplicate values keep the first descriptor", () => {
    const parsed = parseRunnerModels([
      { value: "opus", displayName: "first" },
      { value: "opus", displayName: "second" },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.displayName).toBe("first");
  });

  test("a malformed list is undefined", () => {
    for (const bad of [
      "opus",
      [1],
      [{}],
      [{ value: "" }],
      [{ value: "x", supportsEffort: "yes" }],
    ]) {
      expect(parseRunnerModels(bad)).toBeUndefined();
    }
  });
});
