import { afterEach, describe, expect, test } from "bun:test";
import { submitApprovalDecision } from "./approvals-api.ts";

/**
 * The approval surface's HTTP half (§13.1), decided here and nowhere in a
 * component: which statuses collapse into which operator-facing outcome, and
 * that the decision only ever travels in the request body — never a URL
 * (§19.4, same rule as the prompt).
 */

type Captured = { url: string; method: string; body: unknown };

const realFetch = globalThis.fetch;

function capture(status: number, body: unknown = {}): Captured {
  const captured = { url: "", method: "", body: undefined } as Captured;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input);
    captured.method = init?.method ?? "GET";
    captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
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

describe("submitApprovalDecision", () => {
  test("a 202 answers decided and posts the decision to the body", async () => {
    const captured = capture(202, { approvalId: "apr-1", state: "decided" });

    const result = await submitApprovalDecision("apr-1", "allow", { "Chạy?": "Có" });

    expect(result).toBe("decided");
    expect(captured.url).toBe("/api/approvals/apr-1/decision");
    expect(captured.method).toBe("POST");
    expect(captured.body).toEqual({ decision: "allow", answers: { "Chạy?": "Có" } });
  });

  test("a deny posts without answers when there are none", async () => {
    const captured = capture(202, { approvalId: "apr-1", state: "decided" });

    const result = await submitApprovalDecision("apr-1", "deny");

    expect(result).toBe("decided");
    expect(captured.body).toEqual({ decision: "deny" });
  });

  test("a 409 answers conflict — the approval was already decided", async () => {
    capture(409, {});

    const result = await submitApprovalDecision("apr-1", "allow");

    expect(result).toBe("conflict");
  });

  test("a 404 answers not_found", async () => {
    capture(404, {});

    const result = await submitApprovalDecision("apr-gone", "deny");

    expect(result).toBe("not_found");
  });

  test("a 401 answers unauthorized", async () => {
    capture(401, {});

    const result = await submitApprovalDecision("apr-1", "allow");

    expect(result).toBe("unauthorized");
  });

  test("a network failure answers error instead of throwing", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const result = await submitApprovalDecision("apr-1", "allow");

    expect(result).toBe("error");
  });
});
