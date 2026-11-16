import { onBeforeUnmount } from "vue";
import { capturePrependAnchor } from "./scroll.ts";

/** Release pending native-anchor ownership synchronously when a route unmounts. */
export function usePrependAnchor(): typeof capturePrependAnchor {
  const pending = new Set<ReturnType<typeof capturePrependAnchor>>();
  onBeforeUnmount(() => {
    for (const anchor of pending) anchor.release();
    pending.clear();
  });
  return (viewport, turns) => {
    const anchor = capturePrependAnchor(viewport, turns);
    pending.add(anchor);
    return {
      restore: anchor.restore,
      release() {
        anchor.release();
        pending.delete(anchor);
      },
    };
  };
}
