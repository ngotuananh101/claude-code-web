import { currentLocale, t } from "@/lib/i18n";

/**
 * The rail's timestamps: "just now" / "5 minutes ago" / "3 hours ago", then the
 * calendar form once a session is older than a day. `now` is a parameter so
 * callers can recompute on a ticker without reaching for Date inside the
 * assertion.
 */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000);
  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return t("time.minutesAgo", { count: minutes });
  if (minutes < 60 * 24) return t("time.hoursAgo", { count: Math.floor(minutes / 60) });

  const at = new Date(ms);
  const sameYear = at.getFullYear() === new Date(now).getFullYear();
  // The calendar form follows the UI locale, not the host locale: a host
  // locale would make both the UI and its tests nondeterministic.
  return at.toLocaleDateString(
    currentLocale.value === "vi" ? "vi-VN" : "en-US",
    sameYear
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" },
  );
}
