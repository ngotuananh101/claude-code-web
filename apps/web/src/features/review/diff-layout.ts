/**
 * Layout decisions for the Monaco diff dialog.
 *
 * The modal is 92vw windowed and 100vw fullscreen, so the viewport alone is
 * not the width the diff actually gets. These helpers take the measured modal
 * width and fall back to the viewport breakpoint only until the first
 * ResizeObserver tick.
 *
 * Why the logic lives here instead of inside `ReviewDialog.vue`: `bun test`
 * cannot compile Vue SFCs in this repo (the SFC gate is the `vue-tsgo`
 * typecheck), so every dialog rule that can be a pure function is extracted
 * and unit-tested here.
 */

/** Split (side-by-side) is the default on wide screens, per spec §4.1. */
export const SIDE_BY_SIDE_MIN_WIDTH = 1024;

/** The minimap toggle hides below this modal width, per spec §4.1. */
export const MINIMAP_MIN_WIDTH = 900;

/** The dialog width in px, or 0 before the content has been measured. */
export function resolveSideBySide(input: {
  override: boolean | null;
  modalWidth: number;
  wideViewport: boolean;
}): boolean {
  // An operator's toggle holds until the dialog closes.
  if (input.override !== null) return input.override;
  if (input.modalWidth > 0) return input.modalWidth >= SIDE_BY_SIDE_MIN_WIDTH;
  return input.wideViewport;
}

export function minimapVisible(input: { modalWidth: number; wideViewport: boolean }): boolean {
  if (input.modalWidth > 0) return input.modalWidth >= MINIMAP_MIN_WIDTH;
  return input.wideViewport;
}
