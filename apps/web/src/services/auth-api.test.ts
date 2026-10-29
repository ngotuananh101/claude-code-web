import { afterEach, describe, expect, test } from "bun:test";
import { fetchSetupStatus, submitSetup } from "./auth-api.ts";

/**
 * First-time setup HTTP surface (§19.1, Task 3).
 *
 * `fetchSetupStatus` reads whether the owner account still needs seeding so the
 * front door can show the setup form or defer to login. `submitSetup` posts the
 * one-shot credentials that create that account. Neither throws: a transport or
 * parse failure becomes a generic Vietnamese outcome so a caller never needs a
 * try/catch.
 */

type Captured = { url: string; method: string; body: unknown };

const realFetch = globalThis.fetch;

function capture(status: number, body: unknown, options: { json?: boolean } = {}): Captured {
  const captured = { url: "", method: "", body: undefined } as Captured;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input);
    captured.method = init?.method ?? "GET";
    captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const text = options.json === false ? String(body) : JSON.stringify(body);
    return new Response(text, {
      status,
      headers: {
        "Content-Type": options.json === false ? "text/plain" : "application/json",
      },
    });
  }) as typeof fetch;
  return captured;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchSetupStatus", () => {
  test("calls GET /auth/setup-status and returns setupRequired", async () => {
    const captured = capture(200, { setupRequired: true });

    const result = await fetchSetupStatus();

    expect(result).toEqual({ setupRequired: true });
    expect(captured.method).toBe("GET");
    expect(captured.url).toBe("/auth/setup-status");
  });

  test("returns setupRequired: false when the owner already exists", async () => {
    capture(200, { setupRequired: false });

    const result = await fetchSetupStatus();

    expect(result).toEqual({ setupRequired: false });
  });

  test("a network failure answers a generic Vietnamese outcome instead of throwing", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const result = await fetchSetupStatus();

    expect(result).toEqual({ setupRequired: false });
  });
});

describe("submitSetup", () => {
  test("posts credentials and returns ok on a 201", async () => {
    const captured = capture(201, { ok: true });

    const result = await submitSetup({ username: "ngotuananh2101", password: "hunter2" });

    expect(result).toEqual({ ok: true });
    expect(captured.method).toBe("POST");
    expect(captured.url).toBe("/auth/setup");
    expect(captured.body).toEqual({ username: "ngotuananh2101", password: "hunter2" });
  });

  test("a 403 (users already exist) maps to a Vietnamese message", async () => {
    capture(403, "forbidden", { json: false });

    const result = await submitSetup({ username: "ngotuananh2101", password: "hunter2" });

    expect(result).toEqual({ ok: false, message: "Tài khoản đã được tạo rồi." });
  });

  test("a 400 (invalid input) maps to a Vietnamese message", async () => {
    capture(400, "bad request", { json: false });

    const result = await submitSetup({ username: "ngotuananh2101", password: "hunter2" });

    expect(result).toEqual({ ok: false, message: "Tài khoản hoặc mật khẩu không hợp lệ." });
  });

  test("a network failure maps to a generic Vietnamese message", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const result = await submitSetup({ username: "ngotuananh2101", password: "hunter2" });

    expect(result).toEqual({ ok: false, message: "Không kết nối được máy chủ." });
  });
});
