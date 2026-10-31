import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "@cc-web/control-db";
import { createSecretBox, type SecretBox } from "../config/secret-box.ts";
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

/** Build a real SecretBox from a fixed server secret for deterministic tests. */
function makeSecretBox(): SecretBox {
  return createSecretBox(new Uint8Array(32).fill(42));
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
    const createRes = await handleCreateProfile(
      createReq,
      { db, secretBox: makeSecretBox() },
      authorized,
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { profile: { profileId: string; name: string } };
    expect(created.profile.profileId).toBeDefined();

    // GET /api/config/profiles
    const listReq = new Request("http://localhost/api/config/profiles");
    const listRes = await handleListProfiles(
      listReq,
      { db, secretBox: makeSecretBox() },
      authorized,
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { profiles: Array<{ id: string; hasKey: boolean }> };
    expect(list.profiles.length).toBe(1);
    expect(list.profiles[0]!.hasKey).toBe(true);
    expect((list.profiles[0] as Record<string, unknown>).apiKey).toBeUndefined();

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
    expect(
      (await handleCreateProfile(badReq, { db, secretBox: makeSecretBox() }, authorized)).status,
    ).toBe(400);
  });

  test("400 on invalid JSON body", async () => {
    const db = makeDb();

    const req = new Request("http://localhost/api/config/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json {{{",
    });
    expect(
      (await handleCreateProfile(req, { db, secretBox: makeSecretBox() }, authorized)).status,
    ).toBe(400);
  });

  test("404 on unknown id for GET", async () => {
    const db = makeDb();

    const req = new Request("http://localhost/api/config/profiles/prof_does-not-exist");
    const res = await handleGetProfile(req, { db, secretBox: makeSecretBox() }, authorized);
    expect(res.status).toBe(404);
  });

  test("PUT with omitted apiKey preserves the stored key", async () => {
    const db = makeDb();
    const secretBox = makeSecretBox();

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
    const createRes = await handleCreateProfile(createReq, { db, secretBox }, authorized);
    const created = (await createRes.json()) as { profile: { profileId: string } };

    // Update without supplying apiKey — the stored key must survive.
    const updateReq = new Request(
      `http://localhost/api/config/profiles/${created.profile.profileId}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Updated Name",
          endpoint: "http://10.0.0.1:8080",
          authField: "ANTHROPIC_API_KEY",
          settingsJson: "{}",
        }),
      },
    );
    const updateRes = await handleUpdateProfile(updateReq, { db, secretBox }, authorized);
    expect(updateRes.status).toBe(200);

    // Re-read via the secret path to confirm the key was preserved.
    const getReq = new Request(`http://localhost/api/config/profiles/${created.profile.profileId}`);
    const getRes = await handleGetProfile(getReq, { db, secretBox }, authorized);
    expect(getRes.status).toBe(200);
    const detail = (await getRes.json()) as {
      profile: { hasKey: boolean; apiKeyMasked: string };
    };
    expect(detail.profile.hasKey).toBe(true);
    // The masked value must be derived from the preserved plaintext "sk-original-key".
    expect(detail.profile.apiKeyMasked).toBe("sk-***key");
  });

  test("DELETE then GET returns 404", async () => {
    const db = makeDb();
    const secretBox = makeSecretBox();

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
    const createRes = await handleCreateProfile(createReq, { db, secretBox }, authorized);
    const created = (await createRes.json()) as { profile: { profileId: string } };

    const delReq = new Request(
      `http://localhost/api/config/profiles/${created.profile.profileId}`,
      {
        method: "DELETE",
      },
    );
    const delRes = await handleDeleteProfile(delReq, { db, secretBox }, authorized);
    expect(delRes.status).toBe(200);

    const getReq = new Request(`http://localhost/api/config/profiles/${created.profile.profileId}`);
    const getRes = await handleGetProfile(getReq, { db, secretBox }, authorized);
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
    expect(
      (await handleCreateProfile(req, { db, secretBox: makeSecretBox() }, authorized)).status,
    ).toBe(400);
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
    expect(
      (await handleCreateProfile(req, { db, secretBox: makeSecretBox() }, authorized)).status,
    ).toBe(400);
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
    expect(
      (await handleCreateProfile(req, { db, secretBox: makeSecretBox() }, authorized)).status,
    ).toBe(400);
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
    const createRes = await handleCreateProfile(
      createReq,
      { db, secretBox: makeSecretBox() },
      authorized,
    );
    expect(createRes.status).toBe(201);

    const created = (await createRes.json()) as { profile: { profileId: string } };
    const getReq = new Request(`http://localhost/api/config/profiles/${created.profile.profileId}`);
    const getRes = await handleGetProfile(getReq, { db, secretBox: makeSecretBox() }, authorized);
    expect(getRes.status).toBe(200);
    const detail = (await getRes.json()) as { profile: { settings: unknown } };
    expect(detail.profile.settings).toEqual({});
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
    expect(
      (await handleCreateProfile(req, { db, secretBox: makeSecretBox() }, authorized)).status,
    ).toBe(400);
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
    expect(
      (await handleCreateProfile(req, { db, secretBox: makeSecretBox() }, authorized)).status,
    ).toBe(400);
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
    expect(
      (await handleUpdateProfile(req, { db, secretBox: makeSecretBox() }, authorized)).status,
    ).toBe(404);
  });

  test("DELETE on unknown id returns 404", async () => {
    const db = makeDb();

    const req = new Request("http://localhost/api/config/profiles/prof_does-not-exist", {
      method: "DELETE",
    });
    expect(
      (await handleDeleteProfile(req, { db, secretBox: makeSecretBox() }, authorized)).status,
    ).toBe(404);
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
    expect(
      (await handleCreateProfile(req, { db, secretBox: makeSecretBox() }, authorized)).status,
    ).toBe(400);
  });

  // --- Task 5b: encrypted-at-rest assertions ---

  test("after POST, api_key_encrypted is not the plaintext and starts with v1.", async () => {
    const db = makeDb();
    const secretBox = makeSecretBox();

    const req = new Request("http://localhost/api/config/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "9Router",
        endpoint: "http://192.168.2.3:20128",
        authField: "ANTHROPIC_AUTH_TOKEN",
        apiKey: "sk-secret-key",
        modelMapping: { sonnet: "prime" },
        settingsJson: "{}",
      }),
    });
    const res = await handleCreateProfile(req, { db, secretBox }, authorized);
    expect(res.status).toBe(201);
    const created = (await res.json()) as { profile: { profileId: string } };

    // Query SQLite directly: the stored column must not be plaintext and must
    // start with the v1. envelope prefix.
    const row = db
      .query("SELECT api_key_encrypted FROM config_profiles WHERE id = ?")
      .get(created.profile.profileId) as { api_key_encrypted: string | null };

    expect(row.api_key_encrypted).not.toBeNull();
    expect(row.api_key_encrypted).not.toContain("sk-secret-key");
    expect(row.api_key_encrypted).toMatch(/^v1\./);
  });

  test("GET returns apiKeyMasked derived from the sealed plaintext", async () => {
    const db = makeDb();
    const secretBox = makeSecretBox();

    const req = new Request("http://localhost/api/config/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "9Router",
        endpoint: "http://192.168.2.3:20128",
        authField: "ANTHROPIC_AUTH_TOKEN",
        apiKey: "sk-secret-key",
        modelMapping: { sonnet: "prime" },
        settingsJson: "{}",
      }),
    });
    const res = await handleCreateProfile(req, { db, secretBox }, authorized);
    const created = (await res.json()) as { profile: { profileId: string } };

    const getReq = new Request(`http://localhost/api/config/profiles/${created.profile.profileId}`);
    const getRes = await handleGetProfile(getReq, { db, secretBox }, authorized);
    expect(getRes.status).toBe(200);
    const detail = (await getRes.json()) as {
      profile: { hasKey: boolean; apiKeyMasked: string };
    };
    // maskApiKey("sk-secret-key") => "sk-***key"
    expect(detail.profile.hasKey).toBe(true);
    expect(detail.profile.apiKeyMasked).toBe("sk-***key");
    // The sealed value must not appear in any response field.
    expect(JSON.stringify(detail)).not.toMatch(/^v1\./);
  });

  test("GET omits apiKeyMasked when the stored seal cannot be opened", async () => {
    const db = makeDb();
    const secretBox = makeSecretBox();

    const req = new Request("http://localhost/api/config/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "9Router",
        endpoint: "http://192.168.2.3:20128",
        authField: "ANTHROPIC_AUTH_TOKEN",
        apiKey: "sk-secret-key",
        modelMapping: {},
        settingsJson: "{}",
      }),
    });
    const res = await handleCreateProfile(req, { db, secretBox }, authorized);
    const created = (await res.json()) as { profile: { profileId: string } };

    // Simulate a rotated server secret: the column holds a well-formed envelope
    // sealed by a DIFFERENT key. open() fails, and the response must not fall
    // back to masking the ciphertext (that would read as "v1.***xyz").
    const foreign = createSecretBox(new Uint8Array(32).fill(43)).seal("sk-rotated");
    db.query("UPDATE config_profiles SET api_key_encrypted = ? WHERE id = ?").run(
      foreign,
      created.profile.profileId,
    );

    const getReq = new Request(`http://localhost/api/config/profiles/${created.profile.profileId}`);
    const getRes = await handleGetProfile(getReq, { db, secretBox }, authorized);
    expect(getRes.status).toBe(200);
    const detail = (await getRes.json()) as {
      profile: { hasKey: boolean; apiKeyMasked?: string };
    };
    expect(detail.profile.hasKey).toBe(true);
    expect(detail.profile.apiKeyMasked).toBeUndefined();
    // Neither the plaintext nor the sealed envelope may appear anywhere.
    expect(JSON.stringify(detail)).not.toContain("sk-rotated");
    expect(JSON.stringify(detail)).not.toContain("v1.");
  });

  test("PUT with empty-string apiKey preserves the stored key (spec §4.2)", async () => {
    const db = makeDb();
    const secretBox = makeSecretBox();

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
    const created = (await (
      await handleCreateProfile(createReq, { db, secretBox }, authorized)
    ).json()) as { profile: { profileId: string } };

    // The edit form posts the credential input as-is; an empty string is what
    // the operator leaves when they mean "keep the stored key" (§4.2).
    const updateReq = new Request(
      `http://localhost/api/config/profiles/${created.profile.profileId}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Preserver",
          endpoint: "http://192.168.2.3:20128",
          authField: "ANTHROPIC_AUTH_TOKEN",
          apiKey: "",
          settingsJson: "{}",
        }),
      },
    );
    const updateRes = await handleUpdateProfile(updateReq, { db, secretBox }, authorized);
    expect(updateRes.status).toBe(200);

    const row = db
      .query("SELECT api_key_encrypted FROM config_profiles WHERE id = ?")
      .get(created.profile.profileId) as { api_key_encrypted: string | null };
    expect(row.api_key_encrypted).not.toBeNull();
    expect(row.api_key_encrypted).toMatch(/^v1\./);

    const getReq = new Request(`http://localhost/api/config/profiles/${created.profile.profileId}`);
    const getRes = await handleGetProfile(getReq, { db, secretBox }, authorized);
    const detail = (await getRes.json()) as {
      profile: { hasKey: boolean; apiKeyMasked?: string };
    };
    expect(detail.profile.hasKey).toBe(true);
    expect(detail.profile.apiKeyMasked).toBe("sk-***key");
  });
});
