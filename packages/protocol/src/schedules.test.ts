import { describe, expect, test } from "bun:test";
import { parseScheduleCancelledPayload, parseScheduleCreatedPayload } from "./schedules.ts";

/**
 * The schedule event payloads.
 *
 * The runner builds these from tool results the model produced, and the server
 * projects them into `scheduled_tasks`. Validation lives here, on both sides,
 * because the server has no schema layer for event payloads — a bad payload
 * that gets past this parser would land in the table and later wedge the tick.
 */

const valid = {
  toolCallId: "toolu_01abc",
  cliTaskId: "af5c4b05",
  cron: "58 17 31 10 *",
  recurring: false,
  prompt: "Kiểm tra dung lượng ổ đĩa",
  nextFireAt: 1793444280000,
  timezone: "Asia/Ho_Chi_Minh",
};

describe("parseScheduleCreatedPayload", () => {
  test("accepts the runner's full payload", () => {
    expect(parseScheduleCreatedPayload(valid)).toEqual(valid);
  });

  test("omits absent optional fields instead of inventing them", () => {
    const { cliTaskId, nextFireAt, ...minimal } = valid;
    expect(parseScheduleCreatedPayload(minimal)).toEqual(minimal);
  });

  test("rejects a cron longer than 200 characters", () => {
    expect(parseScheduleCreatedPayload({ ...valid, cron: "x".repeat(201) })).toBeUndefined();
  });

  test("rejects an empty prompt", () => {
    expect(parseScheduleCreatedPayload({ ...valid, prompt: "" })).toBeUndefined();
  });

  test("rejects a non-boolean recurring", () => {
    expect(parseScheduleCreatedPayload({ ...valid, recurring: "false" })).toBeUndefined();
  });

  test("rejects a non-positive nextFireAt", () => {
    expect(parseScheduleCreatedPayload({ ...valid, nextFireAt: -5 })).toBeUndefined();
  });

  test("rejects a missing toolCallId and a missing timezone", () => {
    const { toolCallId, ...noToolCall } = valid;
    const { timezone, ...noTimezone } = valid;
    expect(parseScheduleCreatedPayload(noToolCall)).toBeUndefined();
    expect(parseScheduleCreatedPayload(noTimezone)).toBeUndefined();
  });

  test("rejects non-objects and arrays", () => {
    expect(parseScheduleCreatedPayload(null)).toBeUndefined();
    expect(parseScheduleCreatedPayload(["cron"])).toBeUndefined();
  });
});

describe("parseScheduleCancelledPayload", () => {
  test("accepts toolCallId and cliTaskId", () => {
    expect(parseScheduleCancelledPayload({ toolCallId: "toolu_1", cliTaskId: "af5c4b05" })).toEqual(
      {
        toolCallId: "toolu_1",
        cliTaskId: "af5c4b05",
      },
    );
  });

  test("rejects a missing cliTaskId", () => {
    expect(parseScheduleCancelledPayload({ toolCallId: "toolu_1" })).toBeUndefined();
  });
});
