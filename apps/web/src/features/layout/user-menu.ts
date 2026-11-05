import { type Locale, t } from "../../lib/i18n/index.ts";
import type { ThemePreference } from "../../lib/theme.ts";

export interface LanguageMenuOption {
  value: Locale;
  flag: string;
  label: string;
  selected: boolean;
}

export interface ThemeMenuOption {
  value: ThemePreference;
  label: string;
  selected: boolean;
}

export interface SubmenuPlacement {
  side: "right" | "top";
  align: "start" | "end";
}

const WIDE_SUBMENU_BREAKPOINT_PX = 640;

/**
 * On wide viewports (>= 640px) the user-menu flyout opens to the right of the
 * sidebar; on narrow mobile viewports where the sidebar is a left drawer
 * (~85vw), opening to the right would overflow the viewport and flip over the
 * trigger row itself, so it opens above the trigger instead.
 */
export function userSubmenuPlacement(viewportWidth: number): SubmenuPlacement {
  if (viewportWidth >= WIDE_SUBMENU_BREAKPOINT_PX) {
    return { side: "right", align: "start" };
  }
  return { side: "top", align: "end" };
}

export function languageTriggerLabel(locale: Locale): string {
  return locale === "en" ? t("user.languageEn") : t("user.languageVi");
}

export function buildLanguageMenuOptions(currentLocale: Locale): LanguageMenuOption[] {
  return [
    {
      value: "vi",
      flag: "🇻🇳",
      label: t("user.languageVi"),
      selected: currentLocale === "vi",
    },
    {
      value: "en",
      flag: "🇺🇸",
      label: t("user.languageEn"),
      selected: currentLocale === "en",
    },
  ];
}

export function themeTriggerLabel(theme: ThemePreference): string {
  switch (theme) {
    case "light":
      return t("user.light");
    case "dark":
      return t("user.dark");
    case "system":
      return t("user.system");
  }
}

export function buildThemeMenuOptions(currentTheme: ThemePreference): ThemeMenuOption[] {
  return [
    {
      value: "light",
      label: t("user.light"),
      selected: currentTheme === "light",
    },
    {
      value: "dark",
      label: t("user.dark"),
      selected: currentTheme === "dark",
    },
    {
      value: "system",
      label: t("user.system"),
      selected: currentTheme === "system",
    },
  ];
}
