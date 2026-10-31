/**
 * Auto-scroll helpers for chat streaming interfaces (§16.1).
 *
 * Sticky scroll keeps the viewport locked to the bottom while content is
 * streaming in, unless the user intentionally scrolls up to read earlier history.
 */

export const DEFAULT_SCROLL_THRESHOLD_PX = 80;

/**
 * Determines whether the viewport is close enough to the bottom to stick.
 * Returns true if the distance from bottom is within the threshold.
 */
export function isNearBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = DEFAULT_SCROLL_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

export const DEFAULT_TOP_THRESHOLD_PX = DEFAULT_SCROLL_THRESHOLD_PX;

/** Turns rendered per page by reverse pagination. */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * First rendered index of the chat window. A pinned start — the reader scrolled
 * up — keeps the top fixed so live appends cannot push text out of view; an
 * unpinned window follows the tail and renders only the newest page.
 */
export function resolveWindowStart(
  pinnedStart: number | null,
  total: number,
  pageSize = DEFAULT_PAGE_SIZE,
): number {
  if (pinnedStart === null) return Math.max(0, total - pageSize);
  return Math.min(Math.max(pinnedStart, 0), total);
}

/** The start index after one more page is prepended above the current window. */
export function previousPageStart(currentStart: number, pageSize = DEFAULT_PAGE_SIZE): number {
  return Math.max(0, currentStart - pageSize);
}

/** True when the viewport is at, or close enough to, the top of the feed. */
export function isNearTop(scrollTop: number, threshold = DEFAULT_TOP_THRESHOLD_PX): boolean {
  return scrollTop <= threshold;
}

/**
 * The `scrollTop` correction that keeps the reading position still when older
 * turns are prepended: everything above the viewport grew by this many pixels,
 * so the viewport must slide down by the same amount. Never negative — a
 * shrinking feed must not fight the user's scroll.
 */
export function computeScrollAnchorOffset(previousHeight: number, nextHeight: number): number {
  const delta = nextHeight - previousHeight;
  return Math.max(delta, 0);
}

/**
 * Whether an appended turn should pull the viewport to the tail.
 *
 * Only a reader already at the bottom follows new content. The turn count is
 * not a proxy for intent: a user turn can arrive from another client or a
 * replay while the operator is deliberately reading earlier history, and
 * scrolling them away mid-read is never what they asked for. The composer's
 * own send does not rely on this — the pendingRun path scrolls
 * unconditionally.
 */
export function shouldFollowAppend(
  previousCount: number,
  nextCount: number,
  userScrolledUp: boolean,
): boolean {
  return nextCount > previousCount && !userScrolledUp;
}

/**
 * Whether the journal should automatically load earlier turns.
 *
 * Only loads when:
 * 1. The user has intentionally scrolled up to read earlier history (`userScrolledUp`).
 * 2. There are earlier turns remaining to be loaded (`hasEarlierTurns`).
 * 3. The viewport is scrollable (`scrollHeight > clientHeight`).
 * 4. The viewport scroll position is near the top of the feed (`isNearTop`).
 *
 * This prevents accidental auto-loading when the feed mounts, when the user is
 * at the bottom, or when the feed fits within the viewport.
 */
export function shouldAutoLoadEarlier(
  userScrolledUp: boolean,
  hasEarlierTurns: boolean,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = DEFAULT_TOP_THRESHOLD_PX,
): boolean {
  if (!userScrolledUp) return false;
  if (!hasEarlierTurns) return false;
  if (scrollHeight <= clientHeight) return false;
  return isNearTop(scrollTop, threshold);
}

/**
 * Determines whether the scroll to bottom should be smooth or instant.
 *
 * Smooth scroll is used ONLY when a single new turn is appended to the tail
 * while following live activity. Initial mount or bulk prepends (e.g. historical
 * messages loading asynchronously) snap instantly with 'auto' so the user is
 * not subjected to an animation across the entire transcript.
 */
export function resolveScrollBehavior(
  previousCount: number,
  nextCount: number,
  previousTailKey?: string,
  nextTailKey?: string,
): ScrollBehavior {
  if (previousCount === 0) return "auto";
  const isTailAppend = nextCount === previousCount + 1 && nextTailKey !== previousTailKey;
  return isTailAppend ? "smooth" : "auto";
}
