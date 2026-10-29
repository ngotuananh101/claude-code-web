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
