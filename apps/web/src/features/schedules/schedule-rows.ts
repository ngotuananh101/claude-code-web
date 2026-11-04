/**
 * Display strings for the inspect panel's Schedules tab (§11.5).
 *
 * Pure: the panel passes a schedule and the current time, and gets the row it
 * renders. Keeping the formatting here means the SFC needs no date math and
 * the edge cases (due now, under a minute, calendar fallback) are unit-tested
 * directly, which an SFC cannot be under `bun test`.
 */

import type { ScheduledTask } from "@cc-web/protocol";
import { currentLocale, t } from "@/lib/i18n";

export type ScheduleRow = {
  scheduleId: string;
  promptPreview: string;
  cadence: string;
  nextFireText: string;
};

/** "Due now" when the slot passed — the tick will pick it up next pass. */
export function formatNextFire(nextFireAt: number, now: number): string {
  const diff = nextFireAt - now;
  if (diff <= 0) return t("schedules.dueNow");
  if (diff < 60_000) return t("schedules.withinMinute");
  if (diff < 3_600_000) return t("schedules.inMinutes", { count: Math.ceil(diff / 60_000) });
  if (diff < 86_400_000) return t("schedules.inHours", { count: Math.ceil(diff / 3_600_000) });
  const loc = currentLocale.value === "vi" ? "vi-VN" : "en-US";
  return t("schedules.at", { date: new Date(nextFireAt).toLocaleString(loc) });
}

const PREVIEW_LENGTH = 80;

export function toScheduleRow(task: ScheduledTask, now: number): ScheduleRow {
  const prompt = task.prompt.trim();
  return {
    scheduleId: task.scheduleId,
    promptPreview: prompt.length > PREVIEW_LENGTH ? `${prompt.slice(0, PREVIEW_LENGTH)}…` : prompt,
    cadence: task.recurring ? t("schedules.recurring") : t("schedules.once"),
    nextFireText: formatNextFire(task.nextFireAt, now),
  };
}
