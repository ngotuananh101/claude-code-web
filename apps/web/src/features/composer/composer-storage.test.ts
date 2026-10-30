import { describe, expect, test } from "bun:test";
import {
  clearComposerSettings,
  DEFAULT_COMPOSER_SETTINGS,
  loadComposerSettings,
  parseComposerSettings,
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
      },
      storage,
    );

    const loaded = loadComposerSettings(null, storage);
    expect(loaded).toEqual({
      permission: "bypassPermissions",
      model: "claude-sonnet-4-5",
      effort: "high",
      ultracode: true,
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
      },
      storage,
    );

    expect(loadComposerSettings("session-1", storage)).toEqual({
      permission: "acceptEdits",
      model: "claude-opus-4-6",
      effort: "max",
      ultracode: true,
    });

    // Session 2 should fall back to default
    expect(loadComposerSettings("session-2", storage)).toEqual({
      permission: "acceptEdits", // because saveComposerSettings updates cc-web.composer.default too
      model: "claude-opus-4-6",
      effort: "max",
      ultracode: true,
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
      },
      storage,
    );
    expect(storage.getItem(sessionSettingsKey("session-1"))).not.toBeNull();
    clearComposerSettings("session-1", storage);
    expect(storage.getItem(sessionSettingsKey("session-1"))).toBeNull();
  });
});
