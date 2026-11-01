import { describe, expect, test } from "bun:test";
import {
  INSPECT_OPEN_KEY,
  initialInspectOpen,
  initialRailOpen,
  loadInspectPreference,
  loadRailPreference,
  parseRailPreference,
  RAIL_OPEN_KEY,
  saveInspectPreference,
  saveRailPreference,
} from "./layout-prefs.ts";

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

describe("layout-prefs", () => {
  test("parses the stored rail flag and rejects anything else", () => {
    expect(parseRailPreference("1")).toBe(true);
    expect(parseRailPreference("0")).toBe(false);
    expect(parseRailPreference(null)).toBeNull();
    expect(parseRailPreference("true")).toBeNull();
    expect(parseRailPreference("")).toBeNull();
  });

  test("a wide viewport starts open unless the operator collapsed the rail", () => {
    expect(initialRailOpen(null, true)).toBe(true);
    expect(initialRailOpen(true, true)).toBe(true);
    expect(initialRailOpen(false, true)).toBe(false);
  });

  test("a narrow viewport always starts closed — the journal keeps the screen", () => {
    expect(initialRailOpen(null, false)).toBe(false);
    expect(initialRailOpen(true, false)).toBe(false);
  });

  test("reads the stored preference, surviving blocked storage", () => {
    const storage = createMockStorage();
    expect(loadRailPreference(storage)).toBeNull();
    storage.setItem(RAIL_OPEN_KEY, "0");
    expect(loadRailPreference(storage)).toBe(false);
    expect(
      loadRailPreference({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBeNull();
  });

  test("writes the preference and ignores a throwing storage", () => {
    const storage = createMockStorage();
    saveRailPreference(false, storage);
    expect(storage.getItem(RAIL_OPEN_KEY)).toBe("0");
    saveRailPreference(true, storage);
    expect(storage.getItem(RAIL_OPEN_KEY)).toBe("1");
    expect(() =>
      saveRailPreference(true, {
        setItem: () => {
          throw new Error("blocked");
        },
      }),
    ).not.toThrow();
  });

  test("the inspection panel starts open unless the operator hid it", () => {
    expect(initialInspectOpen(null)).toBe(true);
    expect(initialInspectOpen(true)).toBe(true);
    expect(initialInspectOpen(false)).toBe(false);
  });

  test("reads the stored inspect preference, surviving blocked storage", () => {
    const storage = createMockStorage();
    expect(loadInspectPreference(storage)).toBeNull();
    storage.setItem(INSPECT_OPEN_KEY, "0");
    expect(loadInspectPreference(storage)).toBe(false);
    storage.setItem(INSPECT_OPEN_KEY, "1");
    expect(loadInspectPreference(storage)).toBe(true);
    expect(
      loadInspectPreference({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBeNull();
  });

  test("writes the inspect preference and ignores a throwing storage", () => {
    const storage = createMockStorage();
    saveInspectPreference(false, storage);
    expect(storage.getItem(INSPECT_OPEN_KEY)).toBe("0");
    saveInspectPreference(true, storage);
    expect(storage.getItem(INSPECT_OPEN_KEY)).toBe("1");
    expect(() =>
      saveInspectPreference(true, {
        setItem: () => {
          throw new Error("blocked");
        },
      }),
    ).not.toThrow();
  });

  test("the rail and inspect preferences are stored under distinct keys", () => {
    expect(RAIL_OPEN_KEY).not.toBe(INSPECT_OPEN_KEY);
  });
});
