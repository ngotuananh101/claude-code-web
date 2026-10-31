import { describe, expect, test } from "bun:test";
import { formToJson, jsonToForm, validateSettingsJson } from "./profiles-logic.ts";

describe("profiles two-way sync logic", () => {
  test("syncs visual form state to valid Claude Code settings JSON", () => {
    const form = {
      name: "9Router",
      endpoint: "http://192.168.2.3:20128",
      apiKey: "sk-test",
      authField: "ANTHROPIC_AUTH_TOKEN" as const,
      modelMapping: { sonnet: "prime", opus: "titan" },
    };
    const jsonStr = formToJson(form, { permissions: { defaultMode: "bypassPermissions" } });
    const parsed = JSON.parse(jsonStr);
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://192.168.2.3:20128");
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-test");
    expect(parsed.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("prime");
    expect(parsed.permissions.defaultMode).toBe("bypassPermissions");
  });

  test("syncs valid JSON state back to form fields", () => {
    const json = JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://my-proxy.com",
        ANTHROPIC_AUTH_TOKEN: "sk-xyz",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "nano",
      },
    });
    const form = jsonToForm(json);
    expect(form.endpoint).toBe("https://my-proxy.com");
    expect(form.apiKey).toBe("sk-xyz");
    expect(form.modelMapping.haiku).toBe("nano");
  });

  test("validates settings JSON syntax", () => {
    expect(validateSettingsJson("{ bad json }").valid).toBe(false);
    expect(validateSettingsJson('{"ok": true}').valid).toBe(true);
  });

  test("jsonToForm throws on invalid JSON", () => {
    expect(() => jsonToForm("{ bad json }")).toThrow();
  });

  test("formToJson omits undefined model roles", () => {
    const form = {
      name: "Minimal",
      endpoint: "http://localhost:8080",
      apiKey: "sk-x",
      authField: "ANTHROPIC_API_KEY" as const,
      modelMapping: { sonnet: "prime" },
    };
    const parsed = JSON.parse(formToJson(form));
    expect(parsed.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("prime");
    expect(parsed.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(parsed.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  });

  test("jsonToForm reads ANTHROPIC_API_KEY when that auth field is present", () => {
    const json = JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "http://192.168.2.3:20128",
        ANTHROPIC_API_KEY: "sk-direct",
      },
    });
    const form = jsonToForm(json);
    expect(form.authField).toBe("ANTHROPIC_API_KEY");
    expect(form.apiKey).toBe("sk-direct");
  });

  test("round-trip form->json->form preserves modelMapping keys only from MODEL_ROLES", () => {
    const form = {
      name: "9Router",
      endpoint: "http://192.168.2.3:20128",
      apiKey: "sk-test",
      authField: "ANTHROPIC_AUTH_TOKEN" as const,
      modelMapping: {
        sonnet: "prime",
        opus: "titan",
        haiku: "nano",
        fable: "fable-model",
        subagent: "sub-agent",
      },
    };
    const jsonStr = formToJson(form);
    const roundTripped = jsonToForm(jsonStr);
    const roles = Object.keys(roundTripped.modelMapping);
    expect(roles).toHaveLength(5);
    expect(roles).toEqual(expect.arrayContaining(["sonnet", "opus", "haiku", "fable", "subagent"]));
    expect(roundTripped.modelMapping.sonnet).toBe("prime");
    expect(roundTripped.modelMapping.opus).toBe("titan");
    expect(roundTripped.modelMapping.haiku).toBe("nano");
    expect(roundTripped.modelMapping.fable).toBe("fable-model");
    expect(roundTripped.modelMapping.subagent).toBe("sub-agent");
  });

  test("validateSettingsJson rejects non-object JSON", () => {
    expect(validateSettingsJson("[1,2,3]").valid).toBe(false);
    expect(validateSettingsJson('"a string"').valid).toBe(false);
    expect(validateSettingsJson("123").valid).toBe(false);
    expect(validateSettingsJson("null").valid).toBe(false);
  });

  test("validateSettingsJson accepts object JSON", () => {
    expect(validateSettingsJson('{"env":{}}').valid).toBe(true);
    expect(validateSettingsJson("{}").valid).toBe(true);
  });
});
