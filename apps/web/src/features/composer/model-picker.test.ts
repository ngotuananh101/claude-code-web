import { describe, expect, test } from "bun:test";
import type { RunnerModel } from "@cc-web/protocol";
import {
  effortAt,
  effortLabel,
  effortLevelsFor,
  effortPosition,
  FALLBACK_MODELS,
  formatModelDescription,
  formatModelDisplayName,
  modelFor,
  modelLabel,
  modelTier,
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
  const models = [
    model({ value: "pro", displayName: "pro", description: "Custom Opus model" }),
    model({ value: "code", displayName: "code", description: "Custom Sonnet model" }),
    model({ value: "default", displayName: "Default (recommended)" }),
  ];

  test("finds a row by value", () => {
    expect(modelFor(models, "code")?.displayName).toBe("code");
    expect(modelFor(models, "gone")).toBeUndefined();
  });

  test("labels with formatted display name, concise for default, falling back to raw value", () => {
    expect(modelLabel(models, "pro")).toBe("pro (Opus)");
    expect(modelLabel(models, "default")).toBe("Mặc định");
    expect(modelLabel(models, "gone")).toBe("gone");
  });
});

describe("modelTier", () => {
  test("detects tier from value", () => {
    expect(modelTier(model({ value: "opus", displayName: "pro" }))).toBe("Opus");
    expect(modelTier(model({ value: "fable", displayName: "pro" }))).toBe("Fable");
    expect(modelTier(model({ value: "sonnet", displayName: "code" }))).toBe("Sonnet");
    expect(modelTier(model({ value: "haiku", displayName: "fast" }))).toBe("Haiku");
  });

  test("detects tier from description", () => {
    expect(modelTier(model({ value: "custom-1", description: "Custom Opus model" }))).toBe("Opus");
    expect(modelTier(model({ value: "custom-2", description: "Custom Sonnet model" }))).toBe(
      "Sonnet",
    );
  });

  test("detects tier from resolvedModel", () => {
    expect(
      modelTier(model({ value: "custom-3", description: "", resolvedModel: "claude-opus-5" })),
    ).toBe("Opus");
    expect(
      modelTier(model({ value: "custom-4", description: "", resolvedModel: "claude-sonnet-5" })),
    ).toBe("Sonnet");
  });

  test("returns null for default and unknown", () => {
    expect(modelTier(model({ value: "default" }))).toBeNull();
    expect(modelTier(model({ value: "unknown-model", description: "" }))).toBeNull();
  });
});

describe("formatModelDisplayName", () => {
  test("localizes default model to Vietnamese", () => {
    expect(
      formatModelDisplayName(model({ value: "default", displayName: "Default (recommended)" })),
    ).toBe("Mặc định (khuyến nghị)");
    expect(formatModelDisplayName(model({ value: "default", displayName: "Default" }))).toBe(
      "Mặc định (khuyến nghị)",
    );
  });

  test("appends base tier in parentheses for custom model aliases", () => {
    expect(
      formatModelDisplayName(
        model({ value: "opus", displayName: "pro", description: "Custom Opus model" }),
      ),
    ).toBe("pro (Opus)");
    expect(
      formatModelDisplayName(
        model({ value: "fable", displayName: "pro", description: "Custom Fable model" }),
      ),
    ).toBe("pro (Fable)");
    expect(
      formatModelDisplayName(
        model({ value: "sonnet", displayName: "code", description: "Custom Sonnet model" }),
      ),
    ).toBe("code (Sonnet)");
    expect(
      formatModelDisplayName(
        model({ value: "haiku", displayName: "fast", description: "Custom Haiku model" }),
      ),
    ).toBe("fast (Haiku)");
  });

  test("does not duplicate tier when displayName already contains it", () => {
    expect(formatModelDisplayName(model({ value: "sonnet", displayName: "Sonnet" }))).toBe(
      "Sonnet",
    );
    expect(formatModelDisplayName(model({ value: "opus", displayName: "Claude 3 Opus" }))).toBe(
      "Claude 3 Opus",
    );
    expect(formatModelDisplayName(model({ value: "haiku", displayName: "Claude Haiku" }))).toBe(
      "Claude Haiku",
    );
  });
});

describe("formatModelDescription", () => {
  test("localizes descriptions into Vietnamese", () => {
    expect(
      formatModelDescription(
        model({ value: "default", description: "Use the default model (currently pro[1m])" }),
      ),
    ).toBe("Để Claude Code tự chọn model (hiện tại pro[1m])");
    expect(
      formatModelDescription(model({ value: "default", description: "Use the default model" })),
    ).toBe("Để Claude Code tự chọn model");
    expect(formatModelDescription(model({ value: "opus", description: "Custom Opus model" }))).toBe(
      "Model Opus tùy chỉnh",
    );
    expect(
      formatModelDescription(model({ value: "sonnet", description: "Custom Sonnet model" })),
    ).toBe("Model Sonnet tùy chỉnh");
    expect(
      formatModelDescription(model({ value: "haiku", description: "Custom Haiku model" })),
    ).toBe("Model Haiku tùy chỉnh");
    expect(
      formatModelDescription(model({ value: "fable", description: "Custom Fable model" })),
    ).toBe("Model Fable tùy chỉnh");
  });
});

describe("effortLabel", () => {
  test("translates effort levels to Vietnamese", () => {
    expect(effortLabel(null)).toBe("tự động");
    expect(effortLabel("low")).toBe("thấp");
    expect(effortLabel("medium")).toBe("vừa");
    expect(effortLabel("high")).toBe("cao");
    expect(effortLabel("xhigh")).toBe("rất cao");
    expect(effortLabel("max")).toBe("tối đa");
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
