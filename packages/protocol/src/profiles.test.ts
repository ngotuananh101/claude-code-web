import { describe, expect, test } from "bun:test";
import { parseModelMapping, parseRunProfilePayload, type RunProfilePayload } from "./profiles.ts";

describe("profiles protocol", () => {
  test("validates model mapping with closed set of roles", () => {
    const valid = {
      sonnet: "prime",
      opus: "titan",
      haiku: "nano",
      fable: "titan",
      subagent: "prime",
    };
    expect(parseModelMapping(valid)).toEqual(valid);

    const partial = { sonnet: "prime" };
    expect(parseModelMapping(partial)).toEqual(partial);

    const invalid = { unknownRole: "custom" };
    expect(parseModelMapping(invalid)).toBeUndefined();
  });

  test("parseModelMapping rejects non-objects and wrong-typed values", () => {
    expect(parseModelMapping(null)).toBeUndefined();
    expect(parseModelMapping(["sonnet"])).toBeUndefined();
    expect(parseModelMapping("prime")).toBeUndefined();
    expect(parseModelMapping({ sonnet: 123 })).toBeUndefined();
    expect(parseModelMapping({ sonnet: "" })).toBeUndefined();
  });

  test("parseModelMapping accepts an absent (undefined) as empty mapping", () => {
    expect(parseModelMapping(undefined)).toEqual({});
  });

  test("validates RunProfilePayload", () => {
    const payload: RunProfilePayload = {
      profileId: "prof_123",
      name: "9Router",
      endpoint: "http://192.168.2.3:20128",
      authField: "ANTHROPIC_AUTH_TOKEN",
      apiKey: "sk-test",
      modelMapping: { sonnet: "prime" },
      settings: { effortLevel: "high" },
    };
    expect(parseRunProfilePayload(payload)).toEqual(payload);
  });

  test("parseRunProfilePayload accepts a payload without optional fields", () => {
    const minimal: RunProfilePayload = {
      profileId: "prof_123",
      name: "9Router",
      endpoint: "http://192.168.2.3:20128",
      authField: "ANTHROPIC_API_KEY",
    };
    expect(parseRunProfilePayload(minimal)).toEqual(minimal);
  });

  test("parseRunProfilePayload rejects missing required fields", () => {
    expect(
      parseRunProfilePayload({ name: "x", endpoint: "http://x", authField: "ANTHROPIC_API_KEY" }),
    ).toBeUndefined();
    expect(
      parseRunProfilePayload({
        profileId: "p",
        endpoint: "http://x",
        authField: "ANTHROPIC_API_KEY",
      }),
    ).toBeUndefined();
    expect(
      parseRunProfilePayload({ profileId: "p", name: "x", authField: "ANTHROPIC_API_KEY" }),
    ).toBeUndefined();
  });

  test("parseRunProfilePayload rejects invalid authField", () => {
    expect(
      parseRunProfilePayload({
        profileId: "p",
        name: "x",
        endpoint: "http://x",
        authField: "BAD_FIELD",
      }),
    ).toBeUndefined();
  });

  test("parseRunProfilePayload rejects non-strings and non-objects", () => {
    expect(parseRunProfilePayload(null)).toBeUndefined();
    expect(parseRunProfilePayload("string")).toBeUndefined();
    expect(parseRunProfilePayload([])).toBeUndefined();
    expect(parseRunProfilePayload({ profileId: 1 })).toBeUndefined();
  });
});
