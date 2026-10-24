import { describe, expect, test } from "bun:test";
import { relativeTime } from "./relative-time.ts";

const NOW = Date.parse("2026-10-24T15:00:00Z");

describe("relativeTime", () => {
  test("the last minute reads as just now", () => {
    expect(relativeTime(NOW - 20_000, NOW)).toBe("just now");
  });

  test("minutes and hours collapse to the short forms", () => {
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
  });

  test("same-year days fall back to the month and day", () => {
    expect(relativeTime(Date.parse("2026-10-04T15:00:00Z"), NOW)).toBe("Oct 4");
  });

  test("other years carry the year along", () => {
    expect(relativeTime(Date.parse("2024-10-04T15:00:00Z"), NOW)).toBe("Oct 4, 2024");
  });

  test("clock skew clamps to just now instead of going negative", () => {
    expect(relativeTime(NOW + 90_000, NOW)).toBe("just now");
  });
});
