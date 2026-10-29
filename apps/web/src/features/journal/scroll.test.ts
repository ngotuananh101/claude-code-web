import { describe, expect, test } from "bun:test";
import { isNearBottom } from "./scroll.ts";

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
