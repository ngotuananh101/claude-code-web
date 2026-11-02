import type { Ref } from "vue";
import { ref } from "vue";
import { en } from "./locales/en.ts";
import { vi } from "./locales/vi.ts";
import type { Locale, TranslationDictionary } from "./types.ts";

const dictionaries: Record<Locale, TranslationDictionary> = {
  vi,
  en,
};

const STORAGE_KEY = "cc-web:locale";

function loadInitialLocale(): Locale {
  if (typeof window !== "undefined") {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "vi" || stored === "en") {
      return stored;
    }
  }
  return "vi";
}

export const currentLocale: Ref<Locale> = ref(loadInitialLocale());

function saveLocale(locale: Locale): void {
  if (typeof window !== "undefined") {
    localStorage.setItem(STORAGE_KEY, locale);
  }
}

export function setLocale(locale: Locale): void {
  currentLocale.value = locale;
  saveLocale(locale);
}

function getNestedValue(obj: unknown, path: string): string | undefined {
  const keys = path.split(".");
  let current: unknown = obj;

  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, biome/noAny
    // biome-ignore lint/suspicious/noExplicitAny: nested dictionary access requires any
    current = (current as Record<string, any>)[key];
  }

  if (typeof current === "string") {
    return current;
  }
  return undefined;
}

function interpolate(str: string, params?: Record<string, string | number>): string {
  if (!params) {
    return str;
  }

  return str.replace(/\{(\w+)\}/g, (_, key) => {
    return params[key] !== undefined ? String(params[key]) : `{${key}}`;
  });
}

export function t(key: string, params?: Record<string, string | number>): string {
  const locale = currentLocale.value;

  // First check current locale
  const currentValue = getNestedValue(dictionaries[locale], key);
  if (currentValue !== undefined) {
    return interpolate(currentValue, params);
  }

  // Fallback to vi, then en, then key
  for (const fallbackLocale of ["vi", "en"] as Locale[]) {
    if (fallbackLocale === locale) continue;
    const value = getNestedValue(dictionaries[fallbackLocale], key);
    if (value !== undefined) {
      return interpolate(value, params);
    }
  }

  return key;
}

export function useI18n() {
  return {
    locale: currentLocale,
    setLocale,
    t,
  };
}
