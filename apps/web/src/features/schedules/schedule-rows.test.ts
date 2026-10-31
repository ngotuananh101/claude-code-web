import { describe, expect, test } from "bun:test";
import type { ScheduledTask } from "@cc-web/protocol";
import { formatNextFire, toScheduleRow } from "./schedule-rows.ts";

const task: ScheduledTask = {
  scheduleId: "sched_1",
  sessionId: "session-1",
  cron: "58 17 31 10 *",
  timezone: "Asia/Ho_Chi_Minh",
  recurring: false,
  prompt: "Kiểm tra dung lượng ổ đĩa",
  nextFireAt: 1_000_000,
  state: "active",
  createdAt: 0,
};

describe("formatNextFire", () => {
  test("a due or past fire reads as due now", () => {
    expect(formatNextFire(1_000_000, 1_000_000)).toBe("đang đến hạn");
    expect(formatNextFire(999_000, 1_000_000)).toBe("đang đến hạn");
  });
  test("under a minute", () => {
    expect(formatNextFire(1_030_000, 1_000_000)).toBe("trong dưới 1 phút");
  });
  test("minutes and hours round up", () => {
    expect(formatNextFire(1_120_000, 1_000_000)).toBe("trong 2 phút");
    expect(formatNextFire(1_000_000 + 3 * 3_600_000, 1_000_000)).toBe("trong 3 giờ");
  });
  test("more than a day uses the calendar form", () => {
    expect(formatNextFire(1_000_000 + 2 * 86_400_000, 1_000_000)).toContain("lúc");
  });
});

describe("toScheduleRow", () => {
  test("builds the panel's display strings", () => {
    expect(toScheduleRow(task, 1_000_000)).toEqual({
      scheduleId: "sched_1",
      promptPreview: "Kiểm tra dung lượng ổ đĩa",
      cadence: "Một lần",
      nextFireText: "đang đến hạn",
    });
  });
  test("a long prompt is cut at 80 characters with an ellipsis", () => {
    const row = toScheduleRow({ ...task, prompt: "x".repeat(100) }, 0);
    expect(row.promptPreview).toBe(`${"x".repeat(80)}…`);
  });
  test("a recurring task reads as repeating", () => {
    expect(toScheduleRow({ ...task, recurring: true }, 0).cadence).toBe("Lặp lại");
  });
});
