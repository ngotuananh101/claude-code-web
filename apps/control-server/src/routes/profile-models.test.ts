import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createProfile, migrate } from "@cc-web/control-db";
import { createSecretBox, type SecretBox } from "../config/secret-box.ts";
import { handleListProfileModels, parseModelList } from "./profile-models.ts";

const authorized = { userId: "user-1", username: "owner" };

function makeDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function makeSecretBox(): SecretBox {
  return createSecretBox(new Uint8Array(32).fill(42));
}

/** A fetch stub that records calls and replays queued responses. */
function stubFetch(responses: Array<Response>): {
  calls: Array<{ url: string; init: RequestInit | undefined }>;
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (next === undefined) throw new Error("unexpected fetch");
      return next;
    },
  };
}

function modelsRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/config/profiles/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function authHeader(init: RequestInit | undefined): string | null {
  const headers = new Headers(init?.headers);
  return headers.get("authorization");
}

describe("parseModelList", () => {
  test("reads Anthropic/OpenAI style data arrays and trims ids", () => {
    expect(
      parseModelList({
        data: [{ id: "claude-sonnet-4-5" }, { id: " claude-opus-4-1 " }],
      }),
    ).toEqual(["claude-sonnet-4-5", "claude-opus-4-1"]);
  });

  test("reads models arrays of strings and objects", () => {
    expect(parseModelList({ models: ["prime", { name: "titan" }, { model: "nano" }] })).toEqual([
      "prime",
      "titan",
      "nano",
    ]);
  });

  test("reads a bare array and drops duplicates and non-strings", () => {
    expect(parseModelList(["a", "a", "", 42, null, "b"])).toEqual(["a", "b"]);
  });

  test("returns an empty list for an unrecognised shape", () => {
    expect(parseModelList({ error: "nope" })).toEqual([]);
    expect(parseModelList(null)).toEqual([]);
  });
});

describe("handleListProfileModels", () => {
  test("calls {endpoint}/models with the typed key as a bearer token", async () => {
    const { calls, fetchImpl } = stubFetch([
      Response.json({ data: [{ id: "claude-sonnet-4-5" }] }),
    ]);
    const res = await handleListProfileModels(
      modelsRequest({
        endpoint: "http://gw.local:20128/",
        authField: "ANTHROPIC_AUTH_TOKEN",
        apiKey: "sk-typed",
      }),
      { db: makeDb(), secretBox: makeSecretBox(), fetchImpl },
      authorized,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: ["claude-sonnet-4-5"] });
    expect(calls[0]!.url).toBe("http://gw.local:20128/models");
    expect(authHeader(calls[0]!.init)).toBe("Bearer sk-typed");
  });

  test("uses the stored key and endpoint when the form sends only a profileId", async () => {
    const db = makeDb();
    const secretBox = makeSecretBox();
    const created = createProfile(db, {
      ownerId: authorized.userId,
      name: "9Router",
      endpoint: "http://192.168.2.3:20128",
      authField: "ANTHROPIC_AUTH_TOKEN",
      apiKey: secretBox.seal("sk-stored"),
      settingsJson: "{}",
    });
    const { calls, fetchImpl } = stubFetch([Response.json({ models: ["prime"] })]);

    const res = await handleListProfileModels(
      modelsRequest({ profileId: created.id }),
      { db, secretBox, fetchImpl },
      authorized,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: ["prime"] });
    expect(calls[0]!.url).toBe("http://192.168.2.3:20128/models");
    expect(authHeader(calls[0]!.init)).toBe("Bearer sk-stored");
  });

  test("sends x-api-key when the profile uses ANTHROPIC_API_KEY", async () => {
    const { calls, fetchImpl } = stubFetch([Response.json({ data: [] })]);
    const res = await handleListProfileModels(
      modelsRequest({
        endpoint: "https://api.anthropic.com/v1",
        authField: "ANTHROPIC_API_KEY",
        apiKey: "sk-ant",
      }),
      { db: makeDb(), secretBox: makeSecretBox(), fetchImpl },
      authorized,
    );

    expect(res.status).toBe(200);
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("x-api-key")).toBe("sk-ant");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models");
  });

  test("retries with the alternate auth header after a 401", async () => {
    const { calls, fetchImpl } = stubFetch([
      new Response("unauthorized", { status: 401 }),
      Response.json({ data: [{ id: "prime" }] }),
    ]);
    const res = await handleListProfileModels(
      modelsRequest({
        endpoint: "http://gw.local",
        authField: "ANTHROPIC_AUTH_TOKEN",
        apiKey: "sk-secret",
      }),
      { db: makeDb(), secretBox: makeSecretBox(), fetchImpl },
      authorized,
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    const headers = new Headers(calls[1]!.init?.headers);
    expect(headers.get("x-api-key")).toBe("sk-secret");
  });

  test("400s when no key is available", async () => {
    const res = await handleListProfileModels(
      modelsRequest({ endpoint: "http://gw.local" }),
      { db: makeDb(), secretBox: makeSecretBox(), fetchImpl: async () => Response.json({}) },
      authorized,
    );
    expect(res.status).toBe(400);
  });

  test("400s on an invalid endpoint", async () => {
    const res = await handleListProfileModels(
      modelsRequest({ endpoint: "not-a-url", apiKey: "sk" }),
      { db: makeDb(), secretBox: makeSecretBox(), fetchImpl: async () => Response.json({}) },
      authorized,
    );
    expect(res.status).toBe(400);
  });

  test("404s when the profile does not exist", async () => {
    const res = await handleListProfileModels(
      modelsRequest({ profileId: "prof_missing" }),
      { db: makeDb(), secretBox: makeSecretBox(), fetchImpl: async () => Response.json({}) },
      authorized,
    );
    expect(res.status).toBe(404);
  });

  test("502s when the gateway is unreachable", async () => {
    const res = await handleListProfileModels(
      modelsRequest({ endpoint: "http://gw.local", apiKey: "sk" }),
      {
        db: makeDb(),
        secretBox: makeSecretBox(),
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
      },
      authorized,
    );
    expect(res.status).toBe(502);
  });

  test("502s when the gateway answers non-JSON", async () => {
    const res = await handleListProfileModels(
      modelsRequest({ endpoint: "http://gw.local", apiKey: "sk" }),
      {
        db: makeDb(),
        secretBox: makeSecretBox(),
        fetchImpl: async () => new Response("<html>oops</html>", { status: 200 }),
      },
      authorized,
    );
    expect(res.status).toBe(502);
  });
});
