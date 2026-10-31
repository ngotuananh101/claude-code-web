import { describe, expect, test } from "bun:test";
import {
  clearComposerSettings,
  DEFAULT_COMPOSER_SETTINGS,
  loadComposerSettings,
  parseComposerSettings,
  STORAGE_KEY_DEFAULT,
  saveComposerSettings,
  sessionSettingsKey,
} from "./composer-storage.ts";

describe("composer-storage", () => {
  function createMockStorage(): Storage {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, val: string) => map.set(key, val),
      removeItem: (key: string) => map.delete(key),
      clear: () => map.clear(),
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      get length() {
        return map.size;
      },
    };
  }

  test("returns DEFAULT_COMPOSER_SETTINGS when storage is empty", () => {
    const storage = createMockStorage();
    const settings = loadComposerSettings(null, storage);
    expect(settings).toEqual(DEFAULT_COMPOSER_SETTINGS);
  });

  test("loads from default storage when sessionId is null", () => {
    const storage = createMockStorage();
    saveComposerSettings(
      null,
      {
        permission: "bypassPermissions",
        model: "claude-sonnet-4-5",
        effort: "high",
        ultracode: true,
        profileId: null,
      },
      storage,
    );

    const loaded = loadComposerSettings(null, storage);
    expect(loaded).toEqual({
      permission: "bypassPermissions",
      model: "claude-sonnet-4-5",
      effort: "high",
      ultracode: true,
      profileId: null,
    });
  });

  test("loads per-session settings when available", () => {
    const storage = createMockStorage();
    // Default setting
    saveComposerSettings(
      null,
      {
        permission: "default",
        model: "default",
        effort: null,
        ultracode: false,
        profileId: null,
      },
      storage,
    );

    // Session 1 setting
    saveComposerSettings(
      "session-1",
      {
        permission: "acceptEdits",
        model: "claude-opus-4-6",
        effort: "max",
        ultracode: true,
        profileId: null,
      },
      storage,
    );

    expect(loadComposerSettings("session-1", storage)).toEqual({
      permission: "acceptEdits",
      model: "claude-opus-4-6",
      effort: "max",
      ultracode: true,
      profileId: null,
    });

    // Session 2 should fall back to default
    expect(loadComposerSettings("session-2", storage)).toEqual({
      permission: "acceptEdits", // because saveComposerSettings updates cc-web.composer.default too
      model: "claude-opus-4-6",
      effort: "max",
      ultracode: true,
      profileId: null,
    });
  });

  test("parseComposerSettings handles corrupted or partial JSON safely", () => {
    expect(parseComposerSettings(null)).toBeNull();
    expect(parseComposerSettings("invalid-json")).toBeNull();
    expect(parseComposerSettings("{}")).toEqual(DEFAULT_COMPOSER_SETTINGS);
    expect(parseComposerSettings(JSON.stringify({ permission: "plan" }))).toEqual({
      ...DEFAULT_COMPOSER_SETTINGS,
      permission: "plan",
    });
  });

  test("clearComposerSettings removes session-specific key", () => {
    const storage = createMockStorage();
    saveComposerSettings(
      "session-1",
      {
        permission: "plan",
        model: "default",
        effort: "low",
        ultracode: false,
        profileId: null,
      },
      storage,
    );
    expect(storage.getItem(sessionSettingsKey("session-1"))).not.toBeNull();
    clearComposerSettings("session-1", storage);
    expect(storage.getItem(sessionSettingsKey("session-1"))).toBeNull();
  });

  // --- Task 7: profileId persistence & backward-compatible migration ---
  test("persists and loads profileId", () => {
    const storage = createMockStorage();
    saveComposerSettings(null, { ...DEFAULT_COMPOSER_SETTINGS, profileId: "prof_123" }, storage);
    expect(loadComposerSettings(null, storage).profileId).toBe("prof_123");
  });

  test("defaults profileId to null for pre-Task-7 stored blobs", () => {
    const storage = createMockStorage();
    // A blob written before `profileId` existed — no such field.
    storage.setItem(
      STORAGE_KEY_DEFAULT,
      JSON.stringify({ permission: "plan", model: "default", effort: null, ultracode: false }),
    );
    const loaded = loadComposerSettings(null, storage);
    expect(loaded.profileId).toBeNull();
    expect(loaded).toEqual({ ...DEFAULT_COMPOSER_SETTINGS, permission: "plan" });
  });
});
