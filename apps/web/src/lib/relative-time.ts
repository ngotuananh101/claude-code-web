/**
 * The rail's timestamps: "vừa xong" / "5 phút trước" / "3 giờ trước", then the
 * calendar form once a session is older than a day. `now` is a parameter so
 * callers can recompute on a ticker without reaching for Date inside the
 * assertion.
 */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000);
  if (minutes < 1) return "vừa xong";
  if (minutes < 60) return `${minutes} phút trước`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} giờ trước`;

  const at = new Date(ms);
  const sameYear = at.getFullYear() === new Date(now).getFullYear();
  // The calendar form is pinned to vi-VN: the rail's labels are Vietnamese,
  // and a host-locale date would make both the UI and its tests
  // nondeterministic.
  return at.toLocaleDateString(
    "vi-VN",
    sameYear
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" },
  );
}
