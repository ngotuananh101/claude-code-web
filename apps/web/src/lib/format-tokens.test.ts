import { describe, expect, test } from "bun:test";
import { formatTokens } from "./format-tokens.ts";

describe("formatTokens", () => {
  test("small counts stay exact", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  test("thousands collapse to one decimal", () => {
    expect(formatTokens(1_000)).toBe("1K");
    expect(formatTokens(12_345)).toBe("12.3K");
  });

  test("millions and billions keep two decimals", () => {
    expect(formatTokens(1_234_567)).toBe("1.23M");
    expect(formatTokens(2_500_000_000)).toBe("2.5B");
  });
});
