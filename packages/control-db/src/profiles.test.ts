import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "./db.ts";
import {
  createProfile,
  deleteProfile,
  getProfileById,
  getProfileWithSecret,
  listProfilesForOwner,
  updateProfile,
} from "./profiles.ts";

describe("profiles repository", () => {
  test("CRUD lifecycle for config_profiles", () => {
    const db = new Database(":memory:");
    migrate(db);

    const created = createProfile(db, {
      ownerId: "user-1",
      name: "9Router",
      endpoint: "http://192.168.2.3:20128",
      authField: "ANTHROPIC_AUTH_TOKEN",
      apiKey: "sk-secret-123",
      modelMapping: { sonnet: "prime" },
      settingsJson: JSON.stringify({ effortLevel: "high" }),
    });

    expect(created.id).toBeDefined();
    expect(created.name).toBe("9Router");

    const listed = listProfilesForOwner(db, "user-1");
    expect(listed.length).toBe(1);
    expect(listed[0]!.hasKey).toBe(true);
    expect((listed[0] as Record<string, unknown>).apiKey).toBeUndefined();

    const withSecret = getProfileWithSecret(db, created.id, "user-1");
    expect(withSecret?.apiKey).toBe("sk-secret-123");

    updateProfile(db, created.id, "user-1", {
      name: "9Router Updated",
      modelMapping: { sonnet: "prime-v2" },
    });

    const updated = getProfileById(db, created.id, "user-1");
    expect(updated?.name).toBe("9Router Updated");
    expect(updated?.modelMapping?.sonnet).toBe("prime-v2");

    expect(deleteProfile(db, created.id, "user-1")).toBe(true);
    expect(getProfileById(db, created.id, "user-1")).toBeNull();
  });
});
