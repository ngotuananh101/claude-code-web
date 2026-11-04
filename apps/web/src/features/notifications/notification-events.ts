/**
 * Browser notification decisions (N1, client half).
 *
 * Pure module: it never touches Notification, the DOM, or a socket, so
 * bun test can exercise every decision. The server sends one bounded
 * `notification` frame per notifiable event to every socket of the
 * owner (see BrowserGateway.notify); this module decides whether that
 * frame becomes a system notification, and what it says.
 *
 * The server cannot know whether the operator wants browser
 * notifications — that preference lives here, in localStorage, and the
 * browser permission lives in the Notification API. Both must allow it.
 * A frame for the session already open in a visible tab becomes no
 * system notification at all: the journal itself is the notification
 * there, and a pop-up on top of it would be noise.
 */

import { t } from "@/lib/i18n";

export const NOTIFIABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "approval.requested",
  "approval.expired",
  "run.finished",
  "run.failed",
  "run.interrupted",
]);

export type BrowserNotificationInput = {
  eventId: string;
  type: string;
  sessionId: string;
  sessionTitle?: string;
  toolName?: string;
  inputSummary?: string;
};

export type BrowserNotificationContent = {
  title: string;
  body: string;
};

const SUMMARY_LIMIT = 200;
const TITLE_LIMIT = 80;

function cap(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value.slice(0, limit).trim();
}

export function isNotifiableBrowserEvent(type: string): boolean {
  return NOTIFIABLE_EVENT_TYPES.has(type);
}

/** Title/body for a system notification, or null for other events. */
export function formatBrowserNotification(
  input: BrowserNotificationInput,
): BrowserNotificationContent | null {
  if (!isNotifiableBrowserEvent(input.type)) return null;
  const session = cap(input.sessionTitle, TITLE_LIMIT) || input.sessionId;
  const tool = cap(input.toolName, TITLE_LIMIT);
  const summary = cap(input.inputSummary, SUMMARY_LIMIT);
  switch (input.type) {
    case "approval.requested":
      return {
        title: t("notifications.approvalRequested"),
        body:
          t("notifications.session", { session }) +
          (tool !== "" ? `\n${t("notifications.tool", { tool })}` : "") +
          (summary !== "" ? `\n${summary}` : ""),
      };
    case "approval.expired":
      return {
        title: t("notifications.approvalExpired"),
        body: t("notifications.session", { session }),
      };
    case "run.finished":
      return {
        title: t("notifications.runFinished"),
        body: t("notifications.session", { session }),
      };
    case "run.failed":
      return { title: t("notifications.runFailed"), body: t("notifications.session", { session }) };
    case "run.interrupted":
      return {
        title: t("notifications.runInterrupted"),
        body: t("notifications.session", { session }),
      };
    default:
      return null;
  }
}

export type ShowDecisionInput = {
  /** Notification.permission value, or "unsupported" when the API is absent. */
  permission: string;
  browserEnabled: boolean;
  documentHidden: boolean;
  /** Session id currently open, or null when no session is open. */
  currentSessionId: string | null;
  eventSessionId: string;
};

/**
 * Whether a notifiable frame should become a system notification.
 * Hidden tab, or a different session open, means yes; the same session
 * open in a visible tab means no (the journal shows it already).
 */
export function shouldShowSystemNotification(input: ShowDecisionInput): boolean {
  if (input.permission !== "granted") return false;
  if (!input.browserEnabled) return false;
  if (input.documentHidden) return true;
  return input.currentSessionId !== input.eventSessionId;
}

/** In-memory dedupe by event id: a redelivered frame notifies once. */
export function createNotificationDedupe(): { seen(eventId: string): boolean } {
  const seenIds = new Set<string>();
  return {
    seen(eventId: string): boolean {
      if (seenIds.has(eventId)) return true;
      seenIds.add(eventId);
      return false;
    },
  };
}

export type SimpleStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export const BROWSER_NOTIFICATION_PREF_KEY = "cc-web:notifications:browser";

export function getBrowserNotificationEnabled(
  storage: SimpleStorage | undefined = undefined,
): boolean {
  if (storage === undefined) return true;
  return storage.getItem(BROWSER_NOTIFICATION_PREF_KEY) !== "0";
}

export function setBrowserNotificationEnabled(
  storage: SimpleStorage | undefined,
  enabled: boolean,
): void {
  if (storage === undefined) return;
  storage.setItem(BROWSER_NOTIFICATION_PREF_KEY, enabled ? "1" : "0");
}
