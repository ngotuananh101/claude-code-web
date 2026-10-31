import { describe, expect, test } from "bun:test";
import { createScheduleObserver } from "./schedule-events.ts";

/**
 * The schedule mirror (§5.2 of the scheduled-tasks design).
 *
 * The observer is stateful on purpose: the tool_use block and its tool_result
 * arrive in different frames, and only the result frame carries the
 * frame-level `tool_use_result` with the CLI's task id and first fire time.
 * `tool-results.ts` deliberately drops that field, so this module reads the
 * raw SDK frame before the executor's normalizers see it.
 */

function assistant(...content: unknown[]): Record<string, unknown> {
  return { type: "assistant", message: { role: "assistant", content } };
}

function result(toolUseResult: unknown, ...content: unknown[]): Record<string, unknown> {
  return {
    type: "user",
    message: { role: "user", content },
    ...(toolUseResult === undefined ? {} : { tool_use_result: toolUseResult }),
  };
}

const cronCreateUse = {
  type: "tool_use",
  id: "toolu_1",
  name: "CronCreate",
  input: {
    cron: "58 17 31 10 *",
    recurring: false,
    prompt: "Kiểm tra dung lượng ổ đĩa",
  },
};

const structured = {
  id: "af5c4b05",
  humanSchedule: "58 17 31 10 *",
  recurring: false,
  durable: false,
  nextFireAt: 1793444280000,
};

describe("createScheduleObserver", () => {
  test("a successful CronCreate mirrors the structured result", () => {
    const observe = createScheduleObserver({ timezone: "Asia/Ho_Chi_Minh" });
    expect(observe(assistant(cronCreateUse))).toEqual([]);
    const events = observe(
      result(structured, { type: "tool_result", tool_use_id: "toolu_1", content: "Scheduled" }),
    );
    expect(events).toEqual([
      {
        type: "schedule.created",
        payload: {
          toolCallId: "toolu_1",
          cliTaskId: "af5c4b05",
          cron: "58 17 31 10 *",
          recurring: false,
          prompt: "Kiểm tra dung lượng ổ đĩa",
          nextFireAt: 1793444280000,
          timezone: "Asia/Ho_Chi_Minh",
        },
      },
    ]);
  });

  test("without a structured result the tool input is the fallback", () => {
    const observe = createScheduleObserver({ timezone: "UTC" });
    observe(assistant(cronCreateUse));
    const events = observe(
      result(undefined, { type: "tool_result", tool_use_id: "toolu_1", content: "ok" }),
    );
    expect(events).toEqual([
      {
        type: "schedule.created",
        payload: {
          toolCallId: "toolu_1",
          cron: "58 17 31 10 *",
          recurring: false,
          prompt: "Kiểm tra dung lượng ổ đĩa",
          timezone: "UTC",
        },
      },
    ]);
  });

  test("a human schedule never replaces the cron expression the server parses", () => {
    // The control server recomputes every later fire from `cron`; a display
    // string such as "Every minute" does not parse. The model's expression is
    // the only machine-readable source.
    const observe = createScheduleObserver({ timezone: "UTC" });
    observe(
      assistant({
        type: "tool_use",
        id: "toolu_4",
        name: "CronCreate",
        input: { cron: "* * * * *", recurring: true, prompt: "Trả lời đúng một từ: TICK" },
      }),
    );
    const events = observe(
      result(
        {
          id: "6a004bca",
          humanSchedule: "Every minute",
          recurring: true,
          durable: false,
          nextFireAt: 1793452812422,
        },
        { type: "tool_result", tool_use_id: "toolu_4", content: "Scheduled" },
      ),
    );
    expect(events[0]?.payload).toMatchObject({ cron: "* * * * *", recurring: true });
  });

  test("an over-limit prompt is truncated with a marker instead of losing the schedule", () => {
    // The wire contract caps `prompt` at 4000 characters, and the server drops
    // a payload that violates it. Without clamping here a long prompt costs
    // the whole schedule, silently — the CLI already told the user "Scheduled".
    const observe = createScheduleObserver({ timezone: "UTC" });
    const prompt = `START ${"x".repeat(4200)} END`;
    observe(
      assistant({
        type: "tool_use",
        id: "toolu_5",
        name: "CronCreate",
        input: { cron: "58 17 31 10 *", recurring: false, prompt },
      }),
    );
    const events = observe(
      result(undefined, { type: "tool_result", tool_use_id: "toolu_5", content: "ok" }),
    );
    const payload = events[0]?.payload as { prompt?: string };
    expect(payload.prompt?.length).toBeLessThanOrEqual(4000);
    expect(payload.prompt?.startsWith("START xxx")).toBe(true);
    expect(payload.prompt?.endsWith("…[truncated by cc-web]")).toBe(true);
  });

  test("an error result mirrors nothing", () => {
    const observe = createScheduleObserver({ timezone: "UTC" });
    observe(assistant(cronCreateUse));
    expect(
      observe(
        result(undefined, {
          type: "tool_result",
          tool_use_id: "toolu_1",
          is_error: true,
          content: "invalid cron",
        }),
      ),
    ).toEqual([]);
  });

  test("CronDelete mirrors a cancellation", () => {
    const observe = createScheduleObserver({ timezone: "UTC" });
    observe(
      assistant({
        type: "tool_use",
        id: "toolu_2",
        name: "CronDelete",
        input: { id: "af5c4b05" },
      }),
    );
    expect(
      observe(
        result(undefined, { type: "tool_result", tool_use_id: "toolu_2", content: "deleted" }),
      ),
    ).toEqual([
      { type: "schedule.cancelled", payload: { toolCallId: "toolu_2", cliTaskId: "af5c4b05" } },
    ]);
  });

  test("a multi-block result frame ignores the frame-level structured result", () => {
    const observe = createScheduleObserver({ timezone: "UTC" });
    observe(assistant(cronCreateUse));
    observe(
      assistant({
        type: "tool_use",
        id: "toolu_9",
        name: "CronDelete",
        input: { id: "other-task" },
      }),
    );
    const events = observe(
      result(
        structured,
        { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
        {
          type: "tool_result",
          tool_use_id: "toolu_9",
          content: "deleted",
        },
      ),
    );
    expect(events).toEqual([
      {
        type: "schedule.created",
        payload: {
          toolCallId: "toolu_1",
          cron: "58 17 31 10 *",
          recurring: false,
          prompt: "Kiểm tra dung lượng ổ đĩa",
          timezone: "UTC",
        },
      },
      { type: "schedule.cancelled", payload: { toolCallId: "toolu_9", cliTaskId: "other-task" } },
    ]);
  });

  test("non-cron tools are ignored", () => {
    const observe = createScheduleObserver({ timezone: "UTC" });
    observe(assistant({ type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "ls" } }));
    expect(
      observe(result(undefined, { type: "tool_result", tool_use_id: "toolu_3", content: "a" })),
    ).toEqual([]);
  });

  test("a tool_result without a remembered tool_use is ignored", () => {
    const observe = createScheduleObserver({ timezone: "UTC" });
    expect(
      observe(result(structured, { type: "tool_result", tool_use_id: "toolu_x", content: "ok" })),
    ).toEqual([]);
  });

  test("the default timezone is a non-empty IANA name", () => {
    const observe = createScheduleObserver();
    observe(assistant(cronCreateUse));
    const events = observe(
      result(undefined, { type: "tool_result", tool_use_id: "toolu_1", content: "ok" }),
    );
    const payload = events[0]?.payload as { timezone?: unknown };
    expect(typeof payload.timezone).toBe("string");
    expect(String(payload.timezone).length).toBeGreaterThan(0);
  });
});
