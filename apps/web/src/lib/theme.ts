import type { ComputedRef, Ref } from "vue";
import { computed, ref } from "vue";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "cc-web:theme";

export interface ThemeDocumentLike {
  documentElement: {
    classList: {
      toggle(token: string, force?: boolean): boolean;
    };
    style: {
      colorScheme: string;
    };
  };
}

export function parseThemePreference(raw: string | null): ThemePreference {
  if (raw === "light" || raw === "dark" || raw === "system") {
    return raw;
  }
  return "system";
}

export function loadThemePreference(storage?: Pick<Storage, "getItem">): ThemePreference {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return "system";
  try {
    return parseThemePreference(store.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function saveThemePreference(
  preference: ThemePreference,
  storage?: Pick<Storage, "setItem">,
): void {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return;
  try {
    store.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // A blocked storage is not a broken shell — the choice is per-visit.
  }
}

export function resolveTheme(preference: ThemePreference, systemIsDark: boolean): ResolvedTheme {
  if (preference === "system") {
    return systemIsDark ? "dark" : "light";
  }
  return preference;
}

export function applyDocumentTheme(resolved: ResolvedTheme, doc?: ThemeDocumentLike): void {
  const target = doc ?? (typeof document !== "undefined" ? document : undefined);
  if (!target) return;
  target.documentElement.classList.toggle("dark", resolved === "dark");
  target.documentElement.style.colorScheme = resolved;
}

function readSystemPrefersDark(): boolean {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  return false;
}

export const currentThemePreference: Ref<ThemePreference> = ref(loadThemePreference());
const systemPrefersDark: Ref<boolean> = ref(readSystemPrefersDark());

export const resolvedTheme: ComputedRef<ResolvedTheme> = computed(() =>
  resolveTheme(currentThemePreference.value, systemPrefersDark.value),
);

export function setThemePreference(
  preference: ThemePreference,
  storage?: Pick<Storage, "setItem">,
  doc?: ThemeDocumentLike,
): void {
  currentThemePreference.value = preference;
  saveThemePreference(preference, storage);
  applyDocumentTheme(resolvedTheme.value, doc);
}

/**
 * Syncs `<html>` with the active theme preference and listens for OS color
 * scheme changes when in `system` mode.
 */
export function initTheme(): () => void {
  systemPrefersDark.value = readSystemPrefersDark();
  applyDocumentTheme(resolvedTheme.value);

  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = (event: MediaQueryListEvent): void => {
    systemPrefersDark.value = event.matches;
    applyDocumentTheme(resolvedTheme.value);
  };
  mediaQuery.addEventListener("change", onChange);
  return () => mediaQuery.removeEventListener("change", onChange);
}

export function useTheme() {
  return {
    theme: currentThemePreference,
    resolvedTheme,
    setTheme: setThemePreference,
  };
}
