import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "@cc-web/control-db";
import {
  handleCreateProfile,
  handleDeleteProfile,
  handleGetProfile,
  handleListProfiles,
  handleUpdateProfile,
} from "./config-routes.ts";

const authorized = { userId: "user-1", username: "owner" };

function makeDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

describe("config-routes (/api/config/profiles)", () => {
  test("creates, lists (with masked secret), updates and deletes profiles", async () => {
    const db = makeDb();

    // POST /api/config/profiles
    const createReq = new Request("http://localhost/api/config/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "9Router",
        endpoint: "http://192.168.2.3:20128",
        authField: "ANTHROPIC_AUTH_TOKEN",
        apiKey: "sk-token",
        modelMapping: { sonnet: "prime" },
        settingsJson: "{}",
      }),
    });
    const createRes = await handleCreateProfile(createReq, { db }, authorized);
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; name: string };
    expect(created.id).toBeDefined();

    // GET /api/config/profiles
    const listReq = new Request("http://localhost/api/config/profiles");
    const listRes = await handleListProfiles(listReq, { db }, authorized);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{ id: string; hasKey: boolean }>;
    expect(list.length).toBe(1);
    expect(list[0]!.hasKey).toBe(true);
    expect((list[0] as Record<string, unknown>).apiKey).toBeUndefined();

    // Rejects invalid endpoint
    const badReq = new Request("http://localhost/api/config/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad",
        endpoint: "not-a-url",
        authField: "ANTHROPIC_AUTH_TOKEN",
      }),
    });
    expect((await handleCreateProfile(badReq, { db }, authorized)).status).toBe(400);
  });

  test("400 on invalid JSON body", async () => {
    const db = makeDb();

    const req = new Request("http://localhost/api/config/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json {{{",
    });
    expect((await handleCreateProfile(req, { db }, authorized)).status).toBe(400);
  });

  test("404 on unknown id for GET", async () => {
    const db = makeDb();

    const req = new Request("http://localhost/api/config/profiles/prof_does-not-exist");
    const res = await handleGetProfile(req, { db }, authorized);
    expect(res.status).toBe(404);
  });

  test("PUT with omitted apiKey preserves the stored key", async () => {
    const db = makeDb();

    // Create a profile with an API key.
    const createReq = new Request("http://localhost/api/config/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Preserver",
        endpoint: "http://192.168.2.3:20128",
        authField: "ANTHROPIC_AUTH_TOKEN",
        apiKey: "sk-original-key",
        settingsJson: "{}",
      }),
    });
    const createRes = await handleCreateProfile(createReq, { db }, authorized);
    const created = (await createRes.json()) as { id: string };

    // Update without supplying apiKey — the stored key must survive.
    const updateReq = new Request(`http://localhost/api/config/profiles/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Updated Name",
        endpoint: "http://10.0.0.1:8080",
        authField: "ANTHROPIC_API_KEY",
        settingsJson: "{}",
      }),
    });
    const updateRes = await handleUpdateProfile(updateReq, { db }, authorized);
    expect(updateRes.status).toBe(200);

    // Re-read via the secret path to confirm the key was preserved.
    const getReq = new Request(`http://localhost/api/config/profiles/${created.id}`);
    const getRes = await handleGetProfile(getReq, { db }, authorized);
    expect(getRes.status).toBe(200);
    const detail = (await getRes.json()) as { hasKey: boolean };
    expect(detail.hasKey).toBe(true);
  });

  test("DELETE then GET returns 404", async () => {
    const db = makeDb();

    const createReq = new Request("http://localhost/api/config/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "To Delete",
        endpoint: "http://192.168.2.3:20128",
        authField: "ANTHROPIC_AUTH_TOKEN",
        apiKey: "sk-token",
        settingsJson: "{}",
      }),
    });
    const createRes = await handleCreateProfile(createReq, { db }, authorized);
    const created = (await createRes.json()) as { id: string };

    const delReq = new Request(`http://localhost/api/config/profiles/${created.id}`, {
      method: "DELETE",
    });
    const delRes = await handleDeleteProfile(delReq, { db }, authorized);
    expect(delRes.status).toBe(200);

    const getReq = new Request(`http://localhost/api/config/profiles/${created.id}`);
    const getRes = await handleGetProfile(getReq, { db }, authorized);
    expect(getRes.status).toBe(404);
  });

  test("modelMapping rejects unknown keys", async () => {
    const db = makeDb();

    const req = new Request("http://localhost/api/config/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad Mapping",
        endpoint: "http://192.168.2.3:20128",
        authField: "ANTHROPIC_AUTH_TOKEN",
        apiKey: "sk-token",
        modelMapping: { sonnet: "prime", unexpected: "evil" },
        settingsJson: "{}",
      }),
    });
    expect((await handleCreateProfile(req, { db }, authorized)).status).toBe(400);
  });

  test("rejects empty name", async () => {
    const db = makeDb();

    const req = new Request("http://localhost/api/config/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "  ",
        endpoint: "http://192.168.2.3:20128",
        authField: "ANTHROPIC_AUTH_TOKEN",
        settingsJson: "{}",
      }),
    });
    expect((await handleCreateProfile(req, { db }, authorized)).status).toBe(400);
  });

  test("rejects invalid authField", async () => {
    const db = makeDb();

    const req = new Request("http://localhost/api/config/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad Auth",
        endpoint: "http://192.168.2.3:20128",
        authField: "INVALID_FIELD",
        settingsJson: "{}",
      }),
    });
    expect((await handleCreateProfile(req, { db }, authorized)).status).toBe(400);
  });

  test("settingsJson defaults to empty object when omitted", async () => {
    const db = makeDb();

    const createReq = new Request("http://localhost/api/config/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "No Settings",
        endpoint: "http://192.168.2.3:20128",
        authField: "ANTHROPIC_AUTH_TOKEN",
        apiKey: "sk-token",
      }),
    });
    const createRes = await handleCreateProfile(createReq, { db }, authorized);
    expect(createRes.status).toBe(201);

    const created = (await createRes.json()) as { id: string };
    const getReq = new Request(`http://localhost/api/config/profiles/${created.id}`);
    const getRes = await handleGetProfile(getReq, { db }, authorized);
    expect(getRes.status).toBe(200);
    const detail = (await getRes.json()) as { settings: unknown };
    expect(detail.settings).toEqual({});
  });

  test("settingsJson rejects non-JSON value", async () => {
    const db = makeDb();

    const req = new Request("http://localhost/api/config/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad Settings",
        endpoint: "http://192.168.2.3:20128",
        authField: "ANTHROPIC_AUTH_TOKEN",
        settingsJson: "not json",
      }),
    });
    expect((await handleCreateProfile(req, { db }, authorized)).status).toBe(400);
  });

  test("settingsJson rejects non-object JSON", async () => {
    const db = makeDb();

    const req = new Request("http://localhost/api/config/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad Settings",
        endpoint: "http://192.168.2.3:20128",
        authField: "ANTHROPIC_AUTH_TOKEN",
        settingsJson: "[1,2,3]",
      }),
    });
    expect((await handleCreateProfile(req, { db }, authorized)).status).toBe(400);
  });

  test("PUT on unknown id returns 404", async () => {
    const db = makeDb();

    const req = new Request("http://localhost/api/config/profiles/prof_does-not-exist", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Updated",
        endpoint: "http://192.168.2.3:20128",
        authField: "ANTHROPIC_AUTH_TOKEN",
        settingsJson: "{}",
      }),
    });
    expect((await handleUpdateProfile(req, { db }, authorized)).status).toBe(404);
  });

  test("DELETE on unknown id returns 404", async () => {
    const db = makeDb();

    const req = new Request("http://localhost/api/config/profiles/prof_does-not-exist", {
      method: "DELETE",
    });
    expect((await handleDeleteProfile(req, { db }, authorized)).status).toBe(404);
  });

  test("modelMapping values must be non-empty strings", async () => {
    const db = makeDb();

    const req = new Request("http://localhost/api/config/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad Mapping Values",
        endpoint: "http://192.168.2.3:20128",
        authField: "ANTHROPIC_AUTH_TOKEN",
        apiKey: "sk-token",
        modelMapping: { sonnet: 123 },
        settingsJson: "{}",
      }),
    });
    expect((await handleCreateProfile(req, { db }, authorized)).status).toBe(400);
  });
});
