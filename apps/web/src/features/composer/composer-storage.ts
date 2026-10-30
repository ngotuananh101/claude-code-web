import type { EffortLevel } from "@cc-web/protocol";

export type ComposerSettings = {
  permission: string;
  model: string;
  effort: EffortLevel | null;
  ultracode: boolean;
};

export const DEFAULT_COMPOSER_SETTINGS: Readonly<ComposerSettings> = {
  permission: "default",
  model: "default",
  effort: null,
  ultracode: false,
};

const STORAGE_KEY_DEFAULT = "cc-web.composer.default";
const STORAGE_KEY_SESSION_PREFIX = "cc-web.composer.session.";

export function sessionSettingsKey(sessionId: string): string {
  return `${STORAGE_KEY_SESSION_PREFIX}${sessionId}`;
}

export function parseComposerSettings(raw: string | null): ComposerSettings | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ComposerSettings>;
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      permission:
        typeof parsed.permission === "string"
          ? parsed.permission
          : DEFAULT_COMPOSER_SETTINGS.permission,
      model: typeof parsed.model === "string" ? parsed.model : DEFAULT_COMPOSER_SETTINGS.model,
      effort:
        parsed.effort === null || typeof parsed.effort === "string"
          ? parsed.effort
          : DEFAULT_COMPOSER_SETTINGS.effort,
      ultracode:
        typeof parsed.ultracode === "boolean"
          ? parsed.ultracode
          : DEFAULT_COMPOSER_SETTINGS.ultracode,
    };
  } catch {
    return null;
  }
}

export function loadComposerSettings(
  sessionId: string | null,
  storage?: Pick<Storage, "getItem">,
): ComposerSettings {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return { ...DEFAULT_COMPOSER_SETTINGS };

  try {
    if (sessionId !== null) {
      const sessionRaw = store.getItem(sessionSettingsKey(sessionId));
      const sessionSettings = parseComposerSettings(sessionRaw);
      if (sessionSettings !== null) return sessionSettings;
    }
    // Fall back to default/last-used settings
    const defaultRaw = store.getItem(STORAGE_KEY_DEFAULT);
    const defaultSettings = parseComposerSettings(defaultRaw);
    if (defaultSettings !== null) return defaultSettings;
  } catch {
    // In case storage throws (e.g. security error)
  }

  return { ...DEFAULT_COMPOSER_SETTINGS };
}

export function saveComposerSettings(
  sessionId: string | null,
  settings: ComposerSettings,
  storage?: Pick<Storage, "setItem">,
): void {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return;

  try {
    const serialized = JSON.stringify(settings);
    // Always update the default/last-used settings
    store.setItem(STORAGE_KEY_DEFAULT, serialized);
    if (sessionId !== null) {
      store.setItem(sessionSettingsKey(sessionId), serialized);
    }
  } catch {
    // A blocked storage is not a broken composer
  }
}

export function clearComposerSettings(
  sessionId: string,
  storage?: Pick<Storage, "removeItem">,
): void {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return;

  try {
    store.removeItem(sessionSettingsKey(sessionId));
  } catch {
    // A blocked storage is not a broken composer
  }
}
