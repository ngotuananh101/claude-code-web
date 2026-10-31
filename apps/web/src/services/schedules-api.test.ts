import { afterEach, describe, expect, test } from "bun:test";
import type { ScheduledTask } from "@cc-web/protocol";
import { cancelSchedule, listSchedules } from "./schedules-api.ts";

/**
 * The schedule surface's HTTP half (§11.5): list a session's schedules, cancel
 * one. Same rules as runs-api — pure status mapping, never throws, ids are
 * URL-encoded.
 */

type Captured = { url: string; method: string };

const realFetch = globalThis.fetch;

function capture(status: number, body: unknown = {}): Captured {
  const captured = { url: "", method: "" } as Captured;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input);
    captured.method = init?.method ?? "GET";
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return captured;
}

afterEach(() => {
  // bun runs every test file in one process: a leaked stub would answer the
  // next file's real fetches with this test's canned status.
  globalThis.fetch = realFetch;
});

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

describe("listSchedules", () => {
  test("a 200 answers the schedules the panel renders", async () => {
    const captured = capture(200, { schedules: [task] });

    const result = await listSchedules("session-1");

    expect(result).toEqual({ ok: true, schedules: [task] });
    expect(captured.method).toBe("GET");
    expect(captured.url).toBe("/api/sessions/session-1/schedules");
  });

  test("a 401 is the session problem, not a generic error", async () => {
    capture(401, {});

    const result = await listSchedules("session-1");

    expect(result).toMatchObject({ ok: false, code: "unauthorized" });
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });

  test("the session id is URL-encoded", async () => {
    const captured = capture(200, { schedules: [] });

    await listSchedules("session /ß");

    expect(captured.url).toBe("/api/sessions/session%20%2F%C3%9F/schedules");
  });
});

describe("cancelSchedule", () => {
  test("a 200 answers cancelled", async () => {
    const captured = capture(200, { ok: true });

    const result = await cancelSchedule("sched_1");

    expect(result).toBe("cancelled");
    expect(captured.method).toBe("DELETE");
    expect(captured.url).toBe("/api/schedules/sched_1");
  });

  test("a 404 is not_found and other failures are error", async () => {
    capture(404, {});
    expect(await cancelSchedule("sched_1")).toBe("not_found");

    capture(403, {});
    expect(await cancelSchedule("sched_1")).toBe("error");

    capture(500, {});
    expect(await cancelSchedule("sched_1")).toBe("error");
  });

  test("the schedule id is URL-encoded", async () => {
    const captured = capture(200, { ok: true });

    await cancelSchedule("sched /ß");

    expect(captured.url).toBe("/api/schedules/sched%20%2F%C3%9F");
  });
});
