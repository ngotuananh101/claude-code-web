/**
 * The model names §8.1 fixes. One list for every hop that names a model: the
 * dispatch route validates against it, the composer labels it, and any future
 * surface derives from the same constant — adding a name here is the whole
 * change.
 *
 * Since the runner advertises the models its Claude Code actually offers
 * (`RunnerModel` below), this list is the *fallback*: a runner that predates
 * discovery advertises nothing, and the route still has something to validate
 * against.
 */
export const MODEL_IDS = ["sonnet", "opus", "haiku"] as const;

export type ModelId = (typeof MODEL_IDS)[number];

/**
 * The effort levels Claude Code speaks. `max` is session-only there (it is
 * never persisted to a settings file), which is exactly why it has to be a
 * wire value: a per-run choice is not a persisted preference.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * One model a runner's Claude Code offers (§5.2), advertised in the hello.
 *
 * `value` is what travels back on a run — the SDK resolves it (a family alias,
 * a full id, or a custom name an operator configured). Everything else is
 * descriptive and may be blank: an older Claude Code reports only some fields,
 * and the UI degrades to the value rather than inventing a label.
 */
export type RunnerModel = {
  value: string;
  resolvedModel?: string | null | undefined;
  displayName: string;
  description: string;
  supportsEffort: boolean;
  /** The levels this model accepts; empty when effort is unsupported. */
  supportedEffortLevels: EffortLevel[];
};

/**
 * Parse the `models` field of a hello or of a runners listing.
 *
 * Absent means the runner predates discovery and advertises none — the same
 * reading as `parseCapabilities`. Anything present but outside the shape is
 * `undefined` (malformed): a model descriptor the server only half understood
 * must not become a run option.
 */
export function parseRunnerModels(value: unknown): RunnerModel[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const models: RunnerModel[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const model = parseRunnerModel(entry);
    if (model === undefined) return undefined;
    if (seen.has(model.value)) continue;
    seen.add(model.value);
    models.push(model);
  }
  return models;
}

function parseRunnerModel(value: unknown): RunnerModel | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const id = record["value"];
  if (typeof id !== "string" || id.trim() === "") return undefined;

  const displayName = record["displayName"];
  const description = record["description"];
  const supportsEffort = record["supportsEffort"];
  const resolvedModel = record["resolvedModel"];
  if (displayName !== undefined && typeof displayName !== "string") return undefined;
  if (description !== undefined && typeof description !== "string") return undefined;
  if (supportsEffort !== undefined && typeof supportsEffort !== "boolean") return undefined;
  if (resolvedModel !== undefined && typeof resolvedModel !== "string") return undefined;

  const levels: EffortLevel[] = [];
  const rawLevels = record["supportedEffortLevels"];
  if (rawLevels !== undefined) {
    if (!Array.isArray(rawLevels)) return undefined;
    for (const level of rawLevels) {
      // An unknown level is dropped, not fatal: a newer Claude Code naming a
      // level this server does not implement must not cost the whole list.
      const known = EFFORT_LEVELS.find((candidate) => candidate === level);
      if (known !== undefined && !levels.includes(known)) levels.push(known);
    }
  }

  return {
    value: id,
    ...(typeof resolvedModel === "string" && resolvedModel.trim() !== ""
      ? { resolvedModel: resolvedModel.trim() }
      : {}),
    displayName: displayName === "" || displayName === undefined ? id : displayName,
    description: typeof description === "string" ? description : "",
    supportsEffort: supportsEffort === true,
    supportedEffortLevels: levels,
  };
}
