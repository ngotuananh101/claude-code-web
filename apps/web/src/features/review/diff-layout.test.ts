import { describe, expect, test } from "bun:test";
import {
  MINIMAP_MIN_WIDTH,
  minimapVisible,
  resolveSideBySide,
  SIDE_BY_SIDE_MIN_WIDTH,
} from "./diff-layout.ts";

describe("diff-layout", () => {
  test("side-by-side defaults to the measured modal width", () => {
    expect(SIDE_BY_SIDE_MIN_WIDTH).toBe(1024);
    expect(resolveSideBySide({ override: null, modalWidth: 1024, wideViewport: false })).toBe(true);
    expect(resolveSideBySide({ override: null, modalWidth: 1023, wideViewport: true })).toBe(false);
  });

  test("an operator toggle wins over the width default", () => {
    expect(resolveSideBySide({ override: true, modalWidth: 500, wideViewport: false })).toBe(true);
    expect(resolveSideBySide({ override: false, modalWidth: 1600, wideViewport: true })).toBe(
      false,
    );
  });

  test("before the dialog is measured, the viewport breakpoint decides", () => {
    expect(resolveSideBySide({ override: null, modalWidth: 0, wideViewport: true })).toBe(true);
    expect(resolveSideBySide({ override: null, modalWidth: 0, wideViewport: false })).toBe(false);
  });

  test("the minimap hides below 900px of modal width", () => {
    expect(MINIMAP_MIN_WIDTH).toBe(900);
    expect(minimapVisible({ modalWidth: 900, wideViewport: false })).toBe(true);
    expect(minimapVisible({ modalWidth: 899, wideViewport: true })).toBe(false);
    expect(minimapVisible({ modalWidth: 0, wideViewport: true })).toBe(true);
    expect(minimapVisible({ modalWidth: 0, wideViewport: false })).toBe(false);
  });
});
