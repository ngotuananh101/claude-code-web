import { describe, expect, test } from "bun:test";
import {
  computeScrollAnchorOffset,
  isNearBottom,
  isNearTop,
  previousPageStart,
  resolveScrollBehavior,
  resolveWindowStart,
  shouldAutoLoadEarlier,
  shouldFollowAppend,
} from "./scroll.ts";

describe("isNearBottom", () => {
  test("returns true when exactly at the bottom", () => {
    // scrollHeight = 1000, clientHeight = 400, scrollTop = 600
    expect(isNearBottom(1000, 600, 400)).toBe(true);
  });

  test("returns true when within the default threshold", () => {
    // distance = 1000 - 550 - 400 = 50 <= 80
    expect(isNearBottom(1000, 550, 400)).toBe(true);
  });

  test("returns false when scrolled up past the threshold", () => {
    // distance = 1000 - 500 - 400 = 100 > 80
    expect(isNearBottom(1000, 500, 400)).toBe(false);
  });

  test("returns true when content fits inside client height without scrolling", () => {
    // distance = 300 - 0 - 400 = -100 <= 80
    expect(isNearBottom(300, 0, 400)).toBe(true);
  });

  test("respects custom threshold", () => {
    expect(isNearBottom(1000, 500, 400, 150)).toBe(true);
    expect(isNearBottom(1000, 500, 400, 50)).toBe(false);
  });
});

describe("computeScrollAnchorOffset", () => {
  test("returns the height difference when earlier content is prepended", () => {
    expect(computeScrollAnchorOffset(1_000, 1_400)).toBe(400);
  });

  test("returns zero when the content did not grow", () => {
    expect(computeScrollAnchorOffset(1_400, 1_400)).toBe(0);
    expect(computeScrollAnchorOffset(1_400, 1_000)).toBe(0);
  });
});

describe("isNearTop", () => {
  test("returns true when within the default threshold", () => {
    expect(isNearTop(0)).toBe(true);
    expect(isNearTop(80)).toBe(true);
  });

  test("returns false when scrolled past the threshold", () => {
    expect(isNearTop(81)).toBe(false);
  });

  test("respects a custom threshold", () => {
    expect(isNearTop(150, 200)).toBe(true);
    expect(isNearTop(150, 100)).toBe(false);
  });
});

describe("resolveWindowStart", () => {
  test("follows the tail when the window is not pinned", () => {
    expect(resolveWindowStart(null, 100)).toBe(80);
    expect(resolveWindowStart(null, 12)).toBe(0);
  });

  test("uses the pinned start, clamped to the feed", () => {
    expect(resolveWindowStart(40, 100)).toBe(40);
    expect(resolveWindowStart(500, 100)).toBe(100);
    expect(resolveWindowStart(0, 100)).toBe(0);
  });
});

describe("previousPageStart", () => {
  test("moves one page up and stops at zero", () => {
    expect(previousPageStart(40)).toBe(20);
    expect(previousPageStart(5)).toBe(0);
    expect(previousPageStart(0)).toBe(0);
  });

  test("respects a custom page size", () => {
    expect(previousPageStart(40, 10)).toBe(30);
  });
});

describe("shouldFollowAppend", () => {
  test("follows the tail when a turn is appended while the reader is at the bottom", () => {
    expect(shouldFollowAppend(12, 13, false)).toBe(true);
  });

  test("does not follow while the reader is scrolled up", () => {
    // The regression this guards: a user turn arriving from another client (or
    // a replay) used to yank a reader out of earlier history.
    expect(shouldFollowAppend(12, 13, true)).toBe(false);
  });

  test("never follows when nothing was appended", () => {
    expect(shouldFollowAppend(12, 12, false)).toBe(false);
    expect(shouldFollowAppend(12, 5, false)).toBe(false);
  });
});

describe("shouldAutoLoadEarlier", () => {
  test("returns true when user intentionally scrolled up, feed is scrollable, near top, and has earlier turns", () => {
    // userScrolledUp=true, hasEarlier=true, scrollTop=50 (<=80), scrollHeight=2000, clientHeight=600
    expect(shouldAutoLoadEarlier(true, true, 50, 2000, 600)).toBe(true);
    expect(shouldAutoLoadEarlier(true, true, 0, 2000, 600)).toBe(true);
    expect(shouldAutoLoadEarlier(true, true, 80, 2000, 600)).toBe(true);
  });

  test("returns false when user has not scrolled up (e.g. at bottom or initial mount)", () => {
    // userScrolledUp=false prevents the flash-expansion bug on session enter
    expect(shouldAutoLoadEarlier(false, true, 0, 2000, 600)).toBe(false);
  });

  test("returns false when there are no earlier turns remaining", () => {
    expect(shouldAutoLoadEarlier(true, false, 0, 2000, 600)).toBe(false);
  });

  test("returns false when feed fits inside viewport without scrolling", () => {
    // scrollHeight <= clientHeight
    expect(shouldAutoLoadEarlier(true, true, 0, 500, 600)).toBe(false);
    expect(shouldAutoLoadEarlier(true, true, 0, 600, 600)).toBe(false);
  });

  test("returns false when scrolled past top threshold", () => {
    expect(shouldAutoLoadEarlier(true, true, 81, 2000, 600)).toBe(false);
    expect(shouldAutoLoadEarlier(true, true, 300, 2000, 600)).toBe(false);
  });

  test("respects custom threshold", () => {
    expect(shouldAutoLoadEarlier(true, true, 100, 2000, 600, 120)).toBe(true);
    expect(shouldAutoLoadEarlier(true, true, 100, 2000, 600, 50)).toBe(false);
  });
});

describe("resolveScrollBehavior", () => {
  test("returns auto for initial population from empty", () => {
    expect(resolveScrollBehavior(0, 10, undefined, "turn-10")).toBe("auto");
  });

  test("returns smooth for single turn tail append", () => {
    expect(resolveScrollBehavior(10, 11, "turn-10", "turn-11")).toBe("smooth");
  });

  test("returns auto for bulk historical prepend or multiple batch loads", () => {
    // Tail key did not change -> historical prepend
    expect(resolveScrollBehavior(5, 55, "live-turn", "live-turn")).toBe("auto");
    // Multiple turns arrived simultaneously
    expect(resolveScrollBehavior(5, 10, "turn-5", "turn-10")).toBe("auto");
  });
});
