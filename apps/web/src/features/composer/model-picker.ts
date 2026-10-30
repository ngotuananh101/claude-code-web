/**
 * The model & effort picker's pure logic (§5.2, §8.1).
 *
 * The component is a thin DOM wrapper — everything with an observable rule
 * lives here so it can be tested without compiling the SFC: which models are
 * offered when the runner advertised none, which effort levels a model
 * accepts, and where the slider's knob sits for each.
 */

import { EFFORT_LEVELS, type EffortLevel, MODEL_IDS, type RunnerModel } from "@cc-web/protocol";

/** The model rows the picker shows for a runner. */
export type PickerModel = RunnerModel;

const MODEL_FALLBACK_LABELS: Record<string, string> = {
  sonnet: "Sonnet",
  opus: "Opus",
  haiku: "Haiku",
};

/**
 * The protocol's own lineup, shown when the runner advertised nothing — a
 * pre-discovery runner, or one that is offline. Effort is offered on every
 * row: the wire accepts all five levels regardless of which model runs, and
 * Claude Code itself downgrades a level a model cannot honour.
 */
export const FALLBACK_MODELS: readonly PickerModel[] = [
  {
    value: "default",
    displayName: "Mặc định",
    description: "Để Claude Code tự chọn model",
    supportsEffort: true,
    supportedEffortLevels: [...EFFORT_LEVELS],
  },
  ...MODEL_IDS.map((value) => ({
    value,
    displayName: MODEL_FALLBACK_LABELS[value] ?? value,
    description: "Runner chưa báo danh sách model",
    supportsEffort: true,
    supportedEffortLevels: [...EFFORT_LEVELS],
  })),
];

/** Known model tiers/families. */
export const KNOWN_TIERS: readonly string[] = ["Opus", "Sonnet", "Haiku", "Fable", "Mythos"];

/** Vietnamese labels for effort levels. */
export const EFFORT_LABELS: Record<string, string> = {
  low: "thấp",
  medium: "vừa",
  high: "cao",
  xhigh: "rất cao",
  max: "tối đa",
};

/** Get the localized label for an effort level, or 'tự động' when null. */
export function effortLabel(effort: EffortLevel | null): string {
  if (effort === null) return "tự động";
  return EFFORT_LABELS[effort] ?? effort;
}

/**
 * Detect the underlying/canonical model tier (e.g. "Opus", "Sonnet", "Haiku").
 * Returns null if the model is the generic "default" entry or if no tier matches.
 */
export function modelTier(model: PickerModel): string | null {
  if (model.value === "default") {
    return null;
  }

  // 1. Direct family match on value (e.g. value: "opus" -> "Opus")
  const valueLower = model.value.toLowerCase();
  for (const tier of KNOWN_TIERS) {
    if (valueLower === tier.toLowerCase()) {
      return tier;
    }
  }

  // 2. Check description (e.g. "Custom Opus model" -> "Opus")
  if (model.description) {
    const descLower = model.description.toLowerCase();
    for (const tier of KNOWN_TIERS) {
      if (descLower.includes(tier.toLowerCase())) {
        return tier;
      }
    }
  }

  // 3. Check resolvedModel if present (e.g. "claude-opus-5" -> "Opus")
  if (model.resolvedModel) {
    const resolvedLower = model.resolvedModel.toLowerCase();
    for (const tier of KNOWN_TIERS) {
      if (resolvedLower.includes(tier.toLowerCase())) {
        return tier;
      }
    }
  }

  // 4. Check if value contains tier (e.g. "claude-3-5-sonnet" -> "Sonnet")
  for (const tier of KNOWN_TIERS) {
    if (valueLower.includes(tier.toLowerCase())) {
      return tier;
    }
  }

  return null;
}

/**
 * Format human-friendly display name in Vietnamese, including the base tier
 * in parentheses when a custom model alias is used (e.g. "pro (Opus)", "code (Sonnet)").
 */
export function formatModelDisplayName(model: PickerModel): string {
  if (model.value === "default" || model.displayName.toLowerCase().startsWith("default")) {
    return "Mặc định (khuyến nghị)";
  }

  const name = model.displayName.trim() || model.value;
  const tier = modelTier(model);

  // If tier is known and the display name doesn't already contain it, append (Tier)
  if (tier && !name.toLowerCase().includes(tier.toLowerCase())) {
    return `${name} (${tier})`;
  }

  return name;
}

/**
 * Format Vietnamese description for the model row when descriptions are toggled open.
 */
export function formatModelDescription(model: PickerModel): string {
  if (!model.description) {
    return "";
  }
  const desc = model.description.trim();
  const descLower = desc.toLowerCase();

  if (model.value === "default" || descLower.startsWith("use the default model")) {
    const match = desc.match(/\((?:currently|hiện tại)\s+([^)]+)\)/i);
    if (match) {
      return `Để Claude Code tự chọn model (hiện tại ${match[1]})`;
    }
    return "Để Claude Code tự chọn model";
  }

  if (descLower === "custom opus model") return "Model Opus tùy chỉnh";
  if (descLower === "custom sonnet model") return "Model Sonnet tùy chỉnh";
  if (descLower === "custom haiku model") return "Model Haiku tùy chỉnh";
  if (descLower === "custom fable model") return "Model Fable tùy chỉnh";
  if (descLower === "custom mythos model") return "Model Mythos tùy chỉnh";

  return desc;
}

/** What the runner advertised, or the protocol's fallback when it said nothing. */
export function pickerModels(advertised: readonly RunnerModel[]): PickerModel[] {
  // A copy, entries included: the constants must not be mutable through the
  // list the picker renders.
  return advertised.length > 0
    ? advertised.map((model) => ({
        ...model,
        supportedEffortLevels: [...model.supportedEffortLevels],
      }))
    : FALLBACK_MODELS.map((model) => ({
        ...model,
        supportedEffortLevels: [...model.supportedEffortLevels],
      }));
}

/** The row for a value, or undefined when the list no longer holds it. */
export function modelFor(models: readonly PickerModel[], value: string): PickerModel | undefined {
  return models.find((model) => model.value === value);
}

/** The label on the closed trigger: the row's display name, else the raw value. */
export function modelLabel(models: readonly PickerModel[], value: string): string {
  if (value === "default") {
    return "Mặc định";
  }
  const model = modelFor(models, value);
  if (!model) {
    return value;
  }
  return formatModelDisplayName(model);
}

/**
 * The effort levels this model offers — `[]` means the picker hides the
 * section entirely (the model has no effort parameter to set).
 */
export function effortLevelsFor(model: PickerModel | undefined): EffortLevel[] {
  if (model === undefined || !model.supportsEffort) return [];
  return model.supportedEffortLevels.length > 0
    ? [...model.supportedEffortLevels]
    : [...EFFORT_LEVELS];
}

/**
 * Keep the chosen effort only while the model accepts it.
 *
 * Switching to a model without that level (or without effort at all) clears
 * it — the SDK then uses its own default. Silently sending a level the model
 * cannot honour would report a depth that was never used.
 */
export function normalizeEffort(
  levels: readonly EffortLevel[],
  effort: EffortLevel | null,
): EffortLevel | null {
  if (effort === null) return null;
  return levels.includes(effort) ? effort : null;
}

/** The next level in the direction of travel; stays put at either end. */
export function stepEffort(
  levels: readonly EffortLevel[],
  effort: EffortLevel | null,
  delta: number,
): EffortLevel | null {
  if (levels.length === 0) return null;
  const current = effort === null ? -1 : levels.indexOf(effort);
  const next = Math.min(levels.length - 1, Math.max(0, current + delta));
  return levels[next] ?? null;
}

/** The level a click/tap at `ratio` (0..1) along the track selects. */
export function effortAt(levels: readonly EffortLevel[], ratio: number): EffortLevel | null {
  if (levels.length === 0) return null;
  const clamped = Math.min(1, Math.max(0, ratio));
  const index = Math.round(clamped * (levels.length - 1));
  return levels[index] ?? null;
}

/** The knob's position (0..1) for a level; the left end when none is chosen. */
export function effortPosition(levels: readonly EffortLevel[], effort: EffortLevel | null): number {
  if (levels.length <= 1) return 0;
  const index = effort === null ? 0 : levels.indexOf(effort);
  if (index < 0) return 0;
  return index / (levels.length - 1);
}
