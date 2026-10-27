import { describe, expect, test } from "bun:test";
import type { RpcResultFrame } from "@cc-web/protocol";
import { PendingRpcRequests } from "./pending-requests.ts";

const frame = (commandId: string): RpcResultFrame => ({
  type: "rpc.result",
  commandId,
  ok: true,
  result: { op: "git.changes", entries: [], truncated: false },
});

/**
 * The timer seam, mirroring the event pump's `schedule`/`unschedule`: the
 * registry never reads the wall clock, so a ten-second wait is one call here.
 */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const cancelled: number[] = [];

  return {
    schedule: (run: () => void, ms: number): unknown => {
      const id = nextId++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    unschedule: (handle: unknown): void => {
      const id = handle as number;
      if (timers.delete(id)) cancelled.push(id);
    },
    advance(ms: number): void {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.run();
        }
      }
    },
    cancelled,
  };
}

describe("PendingRpcRequests", () => {
  test("resolves a registered request when its frame settles", async () => {
    const reg = new PendingRpcRequests();
    const pending = reg.register("c1");

    expect(reg.settle(frame("c1"))).toBe(true);
    await expect(pending).resolves.toMatchObject({ commandId: "c1", ok: true });
    expect(reg.size()).toBe(0);
  });

  test("drops a frame with no waiter", () => {
    const reg = new PendingRpcRequests();
    expect(reg.settle(frame("gone"))).toBe(false);
    expect(reg.size()).toBe(0);
  });

  test("rejects with RUNNER_UNAVAILABLE after the timeout and forgets the waiter", async () => {
    const clock = fakeClock();
    const reg = new PendingRpcRequests({
      timeoutMs: 10_000,
      schedule: clock.schedule,
      unschedule: clock.unschedule,
    });

    const pending = reg.register("c1");
    clock.advance(10_000);

    await expect(pending).rejects.toMatchObject({ code: "RUNNER_UNAVAILABLE" });
    expect(reg.size()).toBe(0);
  });

  test("a settle cancels the timeout and does not reject afterwards", async () => {
    const clock = fakeClock();
    const reg = new PendingRpcRequests({ schedule: clock.schedule, unschedule: clock.unschedule });

    const pending = reg.register("c1");
    reg.settle(frame("c1"));
    clock.advance(60_000);

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(clock.cancelled.length).toBeGreaterThan(0);
  });

  test("reject settles the waiter with the given code", async () => {
    const reg = new PendingRpcRequests();
    const pending = reg.register("c1");

    expect(reg.reject("c1", "RUNNER_UNAVAILABLE")).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "RUNNER_UNAVAILABLE" });
    expect(reg.size()).toBe(0);
  });

  test("rejecting an unknown request reports that nobody was waiting", () => {
    const reg = new PendingRpcRequests();
    expect(reg.reject("gone", "RUNNER_UNAVAILABLE")).toBe(false);
  });

  test("a second registration for the same id fails the first instead of leaking it", async () => {
    const clock = fakeClock();
    const reg = new PendingRpcRequests({ schedule: clock.schedule, unschedule: clock.unschedule });

    const first = reg.register("c1");
    const second = reg.register("c1");

    await expect(first).rejects.toMatchObject({ code: "DUPLICATE_COMMAND_ID" });
    expect(reg.size()).toBe(1);

    reg.settle(frame("c1"));
    await expect(second).resolves.toMatchObject({ commandId: "c1" });
  });
});
