import { afterEach, describe, expect, test } from "bun:test";
import {
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  updateProfile,
} from "./profiles-api.ts";

/**
 * The profiles screen's HTTP half (§4.5 / §4.2). These tests pin the envelope
 * contract with the control server — `{ profiles }` and `{ profile }` — so a
 * route that reverts to a bare body fails here instead of rendering an empty
 * editor (the C1 review finding).
 */

type Captured = { url: string; method: string; body: unknown };

const realFetch = globalThis.fetch;

function capture(status: number, body: unknown = {}): Captured {
  const captured: Captured = { url: "", method: "", body: undefined };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input);
    captured.method = init?.method ?? "GET";
    captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return captured;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const summary = {
  profileId: "prof_1",
  name: "9Router",
  endpoint: "http://192.168.2.3:20128",
  authField: "ANTHROPIC_AUTH_TOKEN" as const,
  hasKey: true,
};

const detail = {
  id: "prof_1",
  profileId: "prof_1",
  name: "9Router",
  endpoint: "http://192.168.2.3:20128",
  authField: "ANTHROPIC_AUTH_TOKEN",
  hasKey: true,
  apiKeyMasked: "sk-***key",
  modelMapping: { sonnet: "prime" },
  settings: { env: { HTTP_PROXY: "http://proxy.local:3128" } },
};

describe("profiles-api envelopes", () => {
  test("listProfiles unwraps the { profiles } envelope", async () => {
    const captured = capture(200, { profiles: [summary] });

    const result = await listProfiles();

    expect(result).toEqual({ ok: true, profiles: [summary] });
    expect(captured.method).toBe("GET");
    expect(captured.url).toBe("/api/config/profiles");
  });

  test("listProfiles rejects a bare array body", async () => {
    capture(200, [summary]);

    const result = await listProfiles();

    expect(result.ok).toBe(false);
  });

  test("getProfile unwraps the { profile } envelope and encodes the id", async () => {
    const captured = capture(200, { profile: detail });

    const result = await getProfile("prof /ß");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.profile.profileId).toBe("prof_1");
    expect(result.profile.settings).toEqual({ env: { HTTP_PROXY: "http://proxy.local:3128" } });
    expect(captured.url).toBe("/api/config/profiles/prof%20%2F%C3%9F");
  });

  test("getProfile rejects a bare detail body (no envelope)", async () => {
    capture(200, detail);

    const result = await getProfile("prof_1");

    expect(result.ok).toBe(false);
  });

  test("createProfile POSTs the body and parses the { profile } echo", async () => {
    const captured = capture(201, { profile: detail });

    const result = await createProfile({
      name: "9Router",
      endpoint: "http://192.168.2.3:20128",
      authField: "ANTHROPIC_AUTH_TOKEN",
    });

    expect(result.ok).toBe(true);
    expect(captured.method).toBe("POST");
    expect(captured.url).toBe("/api/config/profiles");
    expect(captured.body).toEqual({
      name: "9Router",
      endpoint: "http://192.168.2.3:20128",
      authField: "ANTHROPIC_AUTH_TOKEN",
    });
  });

  test("updateProfile PUTs to the encoded id and omits an absent apiKey", async () => {
    const captured = capture(200, { profile: detail });

    const result = await updateProfile("prof_1", {
      name: "9Router",
      endpoint: "http://192.168.2.3:20128",
      authField: "ANTHROPIC_AUTH_TOKEN",
    });

    expect(result.ok).toBe(true);
    expect(captured.method).toBe("PUT");
    expect(captured.url).toBe("/api/config/profiles/prof_1");
    expect("apiKey" in (captured.body as Record<string, unknown>)).toBe(false);
  });

  test("deleteProfile maps statuses to outcomes", async () => {
    capture(200, { ok: true });
    expect(await deleteProfile("prof_1")).toBe("deleted");

    capture(404, {});
    expect(await deleteProfile("prof_1")).toBe("not_found");

    capture(401, {});
    expect(await deleteProfile("prof_1")).toBe("unauthorized");

    capture(500, {});
    expect(await deleteProfile("prof_1")).toBe("error");
  });
});
