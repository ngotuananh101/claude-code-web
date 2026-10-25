import { describe, expect, test } from "bun:test";
import { MODEL_IDS, type ModelId } from "./models.ts";

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
