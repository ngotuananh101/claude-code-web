import { afterEach, describe, expect, test } from "bun:test";
import { approvalUi, submitDecision } from "./store.ts";

/**
 * The decision card's optimistic state (§13.2), decided here and nowhere in a
 * component: which API outcome lands where in the per-approval UI state, and
 * that `deciding` is only ever true while the POST is in flight.
 */

const realFetch = globalThis.fetch;

function stubFetch(status: number): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({}), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

afterEach(() => {
  // bun runs every test file in one process: a leaked stub would answer the
  // next file's real fetches with this test's canned status.
  globalThis.fetch = realFetch;
});

describe("submitDecision outcomes", () => {
  test("a decided POST records the decision optimistically and clears deciding", async () => {
    stubFetch(202);
    await submitDecision("apr-store-1", "allow");
    const state = approvalUi("apr-store-1");
    expect(state.decision).toBe("allow");
    expect(state.deciding).toBe(false);
  });

  test("a deny records deny", async () => {
    stubFetch(202);
    await submitDecision("apr-store-2", "deny");
    expect(approvalUi("apr-store-2").decision).toBe("deny");
  });

  test("a conflict leaves the decision unset", async () => {
    stubFetch(409);
    await submitDecision("apr-store-3", "allow");
    const state = approvalUi("apr-store-3");
    expect(state.decision).toBeUndefined();
    expect(state.deciding).toBe(false);
  });

  test("not_found leaves the decision unset", async () => {
    stubFetch(404);
    await submitDecision("apr-store-4", "allow");
    expect(approvalUi("apr-store-4").decision).toBeUndefined();
  });

  test("unauthorized leaves the decision unset", async () => {
    stubFetch(401);
    await submitDecision("apr-store-5", "deny");
    expect(approvalUi("apr-store-5").decision).toBeUndefined();
  });

  test("a network failure lands on the error path with the decision unset", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    await submitDecision("apr-store-6", "allow");
    const state = approvalUi("apr-store-6");
    expect(state.decision).toBeUndefined();
    expect(state.deciding).toBe(false);
  });

  test("deciding is true only while the POST is in flight", async () => {
    let release: (() => void) | undefined;
    globalThis.fetch = (async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response(JSON.stringify({}), { status: 202 });
    }) as typeof fetch;

    const pending = submitDecision("apr-store-7", "allow");
    expect(approvalUi("apr-store-7").deciding).toBe(true);
    release?.();
    await pending;
    expect(approvalUi("apr-store-7").deciding).toBe(false);
    expect(approvalUi("apr-store-7").decision).toBe("allow");
  });
});
