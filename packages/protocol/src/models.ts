/**
 * The model names §8.1 fixes. One list for every hop that names a model: the
 * dispatch route validates against it, the composer labels it, and any future
 * surface derives from the same constant — adding a name here is the whole
 * change.
 */
export const MODEL_IDS = ["sonnet", "opus", "haiku"] as const;

export type ModelId = (typeof MODEL_IDS)[number];
