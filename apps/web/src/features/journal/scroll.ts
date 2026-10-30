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
