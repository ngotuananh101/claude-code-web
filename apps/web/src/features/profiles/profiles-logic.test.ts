import { describe, expect, test } from "bun:test";
import type { ProfileDetail } from "@cc-web/protocol";
import {
  formFreeSettings,
  formToJson,
  jsonToForm,
  nextSelectedProfileId,
  profileFormFromDetail,
  profileSaveBody,
  validateSettingsJson,
} from "./profiles-logic.ts";

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

  // --- Review fixes: form-free settings, editor seeding, save body ---

  test("formFreeSettings strips form-owned env keys but keeps custom env and top-level settings", () => {
    const settings = {
      env: {
        ANTHROPIC_BASE_URL: "http://192.168.2.3:20128",
        ANTHROPIC_AUTH_TOKEN: "sk-token",
        ANTHROPIC_API_KEY: "sk-key",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "prime",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "titan",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "nano",
        ANTHROPIC_DEFAULT_FABLE_MODEL: "fable",
        CLAUDE_CODE_SUBAGENT_MODEL: "worker",
        HTTP_PROXY: "http://proxy.local:3128",
      },
      permissions: { defaultMode: "plan" },
    };

    expect(formFreeSettings(settings)).toEqual({
      env: { HTTP_PROXY: "http://proxy.local:3128" },
      permissions: { defaultMode: "plan" },
    });
  });

  test("formFreeSettings drops an env block that holds only form-owned keys", () => {
    const settings = {
      env: { ANTHROPIC_BASE_URL: "http://192.168.2.3:20128", ANTHROPIC_AUTH_TOKEN: "sk" },
    };
    expect(formFreeSettings(settings)).toEqual({});
  });

  test("formToJson keeps custom env entries and lets the form own its own keys", () => {
    const form = {
      name: "9Router",
      endpoint: "http://192.168.2.3:20128",
      apiKey: "sk-new",
      authField: "ANTHROPIC_AUTH_TOKEN" as const,
      modelMapping: { sonnet: "prime" },
    };
    const parsed = JSON.parse(
      formToJson(form, {
        env: { HTTP_PROXY: "http://proxy.local:3128", ANTHROPIC_BASE_URL: "http://stale-url" },
      }),
    );
    expect(parsed.env.HTTP_PROXY).toBe("http://proxy.local:3128");
    // The form's endpoint wins over a stale stored value.
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://192.168.2.3:20128");
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-new");
  });

  test("jsonToForm carries custom env entries into settingsJson", () => {
    const form = jsonToForm(
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://my-proxy.com",
          ANTHROPIC_AUTH_TOKEN: "sk-xyz",
          HTTP_PROXY: "http://proxy.local:3128",
        },
        permissions: { defaultMode: "plan" },
      }),
    );
    expect(JSON.parse(form.settingsJson)).toEqual({
      env: { HTTP_PROXY: "http://proxy.local:3128" },
      permissions: { defaultMode: "plan" },
    });
  });

  test("a custom env entry survives the full editor round-trip", () => {
    const original = {
      env: { ANTHROPIC_BASE_URL: "https://my-proxy.com", HTTP_PROXY: "http://proxy.local:3128" },
    };
    const form = jsonToForm(JSON.stringify(original));
    const regenerated = JSON.parse(formToJson(form, JSON.parse(form.settingsJson)));
    expect(regenerated.env.HTTP_PROXY).toBe("http://proxy.local:3128");
    expect(regenerated.env.ANTHROPIC_BASE_URL).toBe("https://my-proxy.com");
  });

  test("profileFormFromDetail never round-trips the masked key into the credential field", () => {
    const detail: ProfileDetail = {
      id: "prof_1",
      profileId: "prof_1",
      name: "9Router",
      endpoint: "http://192.168.2.3:20128",
      authField: "ANTHROPIC_API_KEY",
      hasKey: true,
      apiKeyMasked: "sk-***key",
      modelMapping: { sonnet: "prime" },
    };
    const form = profileFormFromDetail(detail);
    expect(form.apiKey).toBe("");
    expect(form.authField).toBe("ANTHROPIC_API_KEY");
    expect(form.modelMapping).toEqual({ sonnet: "prime" });
  });

  test("profileSaveBody omits an empty apiKey and an empty settings object", () => {
    const body = profileSaveBody({
      name: "9Router",
      endpoint: "http://192.168.2.3:20128",
      apiKey: "",
      authField: "ANTHROPIC_AUTH_TOKEN",
      modelMapping: {},
    });
    expect("apiKey" in body).toBe(false);
    expect("settingsJson" in body).toBe(false);
  });

  test("profileSaveBody includes a typed key and serialized extra settings", () => {
    const body = profileSaveBody(
      {
        name: "9Router",
        endpoint: "http://192.168.2.3:20128",
        apiKey: "sk-new",
        authField: "ANTHROPIC_AUTH_TOKEN",
        modelMapping: { sonnet: "prime" },
      },
      { env: { HTTP_PROXY: "http://proxy.local:3128" } },
    );
    expect(body.apiKey).toBe("sk-new");
    expect(JSON.parse(body.settingsJson!)).toEqual({
      env: { HTTP_PROXY: "http://proxy.local:3128" },
    });
  });

  test("nextSelectedProfileId keeps a live selection, else falls back to the first entry", () => {
    const profiles = [{ profileId: "prof_a" }, { profileId: "prof_b" }];
    expect(nextSelectedProfileId(profiles, "prof_b")).toBe("prof_b");
    expect(nextSelectedProfileId(profiles, "prof_gone")).toBe("prof_a");
    expect(nextSelectedProfileId(profiles, null)).toBe("prof_a");
    expect(nextSelectedProfileId([], "prof_a")).toBeNull();
  });
});
