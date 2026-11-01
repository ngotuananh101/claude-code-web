/** Console shell preferences: whether the left rail starts open.
 *
 * The rail is inline beside the page on a wide viewport and a drawer over it
 * on a narrow one. Its default follows the viewport — open on a wide screen,
 * collapsed on a phone — but the operator's own choice is stored at every
 * width and wins on the next visit.
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
 * The rail starts with the viewport's default — open when it is a column
 * beside the page, collapsed when it is a drawer over it — unless the
 * operator has chosen otherwise. A stored choice wins at every width: a rail
 * left open on a phone must still be open after a reload.
 */
export function initialRailOpen(stored: boolean | null, isWide: boolean): boolean {
  return stored ?? isWide;
}

/**
 * What a live breakpoint crossing adopts.
 *
 * Narrowing is not a visit — it is the same session in a smaller window — so
 * the drawer follows the narrow viewport's default instead of popping over
 * the page because the desktop rail was open. Widening restores the stored
 * choice for the inline rail, falling back to open.
 */
export function railOpenOnViewportChange(stored: boolean | null, isWide: boolean): boolean {
  return isWide ? (stored ?? true) : false;
}

/**
 * The inspection panel beside the journal can be hidden outright. It is not a
 * drawer — it docks beside the journal on wide screens and under it on narrow
 * ones — so the operator's choice is stored at every viewport width. It starts
 * collapsed: the journal owns the screen until the operator asks for the
 * secondary panel from the right-edge tab.
 */
export const INSPECT_OPEN_KEY = "cc-web.inspect.open";

export function loadInspectPreference(storage?: Pick<Storage, "getItem">): boolean | null {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return null;
  try {
    return parseRailPreference(store.getItem(INSPECT_OPEN_KEY));
  } catch {
    // A blocked storage is not a broken shell — fall back to the default.
    return null;
  }
}

export function saveInspectPreference(open: boolean, storage?: Pick<Storage, "setItem">): void {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!store) return;
  try {
    store.setItem(INSPECT_OPEN_KEY, open ? "1" : "0");
  } catch {
    // A blocked storage is not a broken shell — the choice is per-visit.
  }
}

/** The inspection panel starts collapsed unless the operator opened it. */
export function initialInspectOpen(stored: boolean | null): boolean {
  return stored ?? false;
}
