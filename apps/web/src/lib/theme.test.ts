import { afterEach, describe, expect, test } from "bun:test";
import {
  applyDocumentTheme,
  loadThemePreference,
  parseThemePreference,
  resolveTheme,
  saveThemePreference,
  setThemePreference,
  THEME_STORAGE_KEY,
  useTheme,
} from "./theme.ts";

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

function createMockDocElement() {
  const classes = new Set<string>();
  return {
    classes,
    documentElement: {
      classList: {
        toggle: (token: string, force?: boolean) => {
          const shouldAdd = force ?? !classes.has(token);
          if (shouldAdd) classes.add(token);
          else classes.delete(token);
          return shouldAdd;
        },
        contains: (token: string) => classes.has(token),
      },
      style: {
        colorScheme: "",
      },
    },
  };
}

describe("theme module", () => {
  afterEach(() => {
    setThemePreference("system");
  });

  test("parses valid theme preferences and defaults to system for unknown values", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference(null)).toBe("system");
    expect(parseThemePreference("")).toBe("system");
    expect(parseThemePreference("solarized")).toBe("system");
  });

  test("resolves effective theme from preference and OS scheme", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  test("loads and saves preference in storage, surviving blocked storage", () => {
    const storage = createMockStorage();
    expect(loadThemePreference(storage)).toBe("system");

    saveThemePreference("light", storage);
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(loadThemePreference(storage)).toBe("light");

    saveThemePreference("dark", storage);
    expect(loadThemePreference(storage)).toBe("dark");

    expect(
      loadThemePreference({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe("system");

    expect(() =>
      saveThemePreference("light", {
        setItem: () => {
          throw new Error("blocked");
        },
      }),
    ).not.toThrow();
  });

  test("applies .dark class and colorScheme style on documentElement", () => {
    const mockDoc = createMockDocElement();
    applyDocumentTheme("dark", mockDoc);
    expect(mockDoc.classes.has("dark")).toBe(true);
    expect(mockDoc.documentElement.style.colorScheme).toBe("dark");

    applyDocumentTheme("light", mockDoc);
    expect(mockDoc.classes.has("dark")).toBe(false);
    expect(mockDoc.documentElement.style.colorScheme).toBe("light");
  });

  test("useTheme reactively updates preference and resolvedTheme", () => {
    const storage = createMockStorage();
    const mockDoc = createMockDocElement();
    const { theme, resolvedTheme, setTheme } = useTheme();

    expect(theme.value).toBe("system");

    setTheme("light", storage, mockDoc);
    expect(theme.value).toBe("light");
    expect(resolvedTheme.value).toBe("light");
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(mockDoc.classes.has("dark")).toBe(false);

    setTheme("dark", storage, mockDoc);
    expect(theme.value).toBe("dark");
    expect(resolvedTheme.value).toBe("dark");
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(mockDoc.classes.has("dark")).toBe(true);
  });
});
