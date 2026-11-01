/** Console shell preferences: whether the left rail starts open.
 *
 * The rail is inline beside the page on a wide viewport and a drawer over it
 * on a narrow one, so the operator's choice is stored for the wide case only;
 * a phone always starts with the journal full-width.
 */

export const RAIL_OPEN_KEY = "cc-web.rail.open";

/** A stored flag ("1"/"0"); null when absent or unreadable. */
export function parseRailPreference(raw: string | null): boolean | null {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

export function loadRailPreference(storage?: Pick<Storage, "getItem">): boolean | null {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return null;
  try {
    return parseRailPreference(store.getItem(RAIL_OPEN_KEY));
  } catch {
    // A blocked storage is not a broken shell — fall back to the default.
    return null;
  }
}

export function saveRailPreference(open: boolean, storage?: Pick<Storage, "setItem">): void {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return;
  try {
    store.setItem(RAIL_OPEN_KEY, open ? "1" : "0");
  } catch {
    // A blocked storage is not a broken shell — the choice is per-visit.
  }
}

/**
 * The rail starts open on a wide viewport unless the operator collapsed it.
 * A narrow viewport always starts closed: the rail is a drawer there, and the
 * journal should own the phone screen until asked otherwise.
 */
export function initialRailOpen(stored: boolean | null, isWide: boolean): boolean {
  return isWide ? (stored ?? true) : false;
}
