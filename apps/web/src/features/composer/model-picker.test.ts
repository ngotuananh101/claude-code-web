import { describe, expect, test } from "bun:test";
import type { RunnerModel } from "@cc-web/protocol";
import {
  effortAt,
  effortLevelsFor,
  effortPosition,
  FALLBACK_MODELS,
  modelFor,
  modelLabel,
  normalizeEffort,
  pickerModels,
  stepEffort,
} from "./model-picker.ts";

/**
 * The picker's rules (§5.2): what is offered when the runner said nothing,
 * which levels a model accepts, and how a click maps onto the track.
 */

function model(overrides: Partial<RunnerModel> = {}): RunnerModel {
  return {
    value: "pro",
    displayName: "pro",
    description: "Custom Opus model",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    ...overrides,
  };
}

describe("pickerModels", () => {
  test("offers what the runner advertised, in its own order", () => {
    const advertised = [model({ value: "pro" }), model({ value: "code", displayName: "code" })];
    expect(pickerModels(advertised).map((entry) => entry.value)).toEqual(["pro", "code"]);
  });

  test("falls back to the protocol lineup when the runner advertised nothing", () => {
    const offered = pickerModels([]);
    expect(offered.map((entry) => entry.value)).toEqual(["default", "sonnet", "opus", "haiku"]);
    // The fallback claims effort on every row: the wire accepts all five levels
    // regardless of the model, and Claude Code downgrades what it cannot honour.
    for (const entry of offered) {
      expect(entry.supportsEffort).toBe(true);
      expect(entry.supportedEffortLevels.length).toBeGreaterThan(0);
    }
  });

  test("the fallback is a copy — a caller cannot mutate the shared list", () => {
    pickerModels([])[0]!.displayName = "mutated";
    expect(FALLBACK_MODELS[0]?.displayName).toBe("Mặc định");
  });
});

describe("modelFor / modelLabel", () => {
  const models = [model({ value: "pro" }), model({ value: "code", displayName: "code" })];

  test("finds a row by value", () => {
    expect(modelFor(models, "code")?.displayName).toBe("code");
    expect(modelFor(models, "gone")).toBeUndefined();
  });

  test("labels with the display name, falling back to the raw value", () => {
    expect(modelLabel(models, "pro")).toBe("pro");
    expect(modelLabel(models, "gone")).toBe("gone");
  });
});

describe("effortLevelsFor", () => {
  test("uses the model's own list", () => {
    expect(effortLevelsFor(model({ supportedEffortLevels: ["low", "high"] }))).toEqual([
      "low",
      "high",
    ]);
  });

  test("falls back to all five levels when the model supports effort but names none", () => {
    expect(effortLevelsFor(model({ supportedEffortLevels: [] }))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("is empty for a model without effort, and for an unknown model", () => {
    expect(effortLevelsFor(model({ supportsEffort: false }))).toEqual([]);
    expect(effortLevelsFor(undefined)).toEqual([]);
  });
});

describe("normalizeEffort", () => {
  test("keeps a level the model accepts", () => {
    expect(normalizeEffort(["low", "max"], "max")).toBe("max");
  });

  test("clears a level the model cannot honour, never downgrades silently", () => {
    expect(normalizeEffort(["low", "high"], "max")).toBeNull();
    expect(normalizeEffort([], "max")).toBeNull();
  });

  test("null stays null", () => {
    expect(normalizeEffort(["low"], null)).toBeNull();
  });
});

describe("stepEffort", () => {
  const levels = ["low", "medium", "high"] as const;

  test("moves one step and stops at either end", () => {
    expect(stepEffort(levels, null, 1)).toBe("low");
    expect(stepEffort(levels, "low", 1)).toBe("medium");
    expect(stepEffort(levels, "high", 1)).toBe("high");
    expect(stepEffort(levels, null, -1)).toBe("low");
  });

  test("no levels means no choice", () => {
    expect(stepEffort([], "low", 1)).toBeNull();
  });
});

describe("effortAt / effortPosition", () => {
  const levels = ["low", "medium", "high", "xhigh", "max"] as const;

  test("a click maps to the nearest tick", () => {
    expect(effortAt(levels, 0)).toBe("low");
    expect(effortAt(levels, 0.3)).toBe("medium");
    expect(effortAt(levels, 0.76)).toBe("xhigh");
    expect(effortAt(levels, 1)).toBe("max");
    // Out-of-range positions clamp rather than throwing.
    expect(effortAt(levels, -3)).toBe("low");
    expect(effortAt(levels, 7)).toBe("max");
  });

  test("the knob sits on the chosen tick, left when nothing is chosen", () => {
    expect(effortPosition(levels, "low")).toBe(0);
    expect(effortPosition(levels, "max")).toBe(1);
    expect(effortPosition(levels, "high")).toBe(0.5);
    expect(effortPosition(levels, null)).toBe(0);
    expect(effortPosition(levels, "gone" as never)).toBe(0);
  });

  test("a single level or none pins the knob at the left", () => {
    expect(effortPosition(["low"], "low")).toBe(0);
    expect(effortPosition([], null)).toBe(0);
  });
});
