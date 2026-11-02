import { afterEach, describe, expect, test } from "bun:test";
import { sessions } from "../stores/sessions.ts";
import { updateUserProfile } from "./user-api.ts";

/**
 * User profile API client (Task 4).
 *
 * `updateUserProfile` calls `PATCH /api/me` with optional username, avatar,
 * currentPassword, and newPassword fields. A 200 response updates the sessions
 * store and returns the new profile. Error responses return a Vietnamese message.
 */

type Captured = { url: string; method: string; body: string; contentType: string };

const realFetch = globalThis.fetch;

function capture(status: number, body: unknown, options: { json?: boolean } = {}): Captured {
  const captured = { url: "", method: "", body: "", contentType: "" } as Captured;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input);
    captured.method = init?.method ?? "GET";
    captured.body = init?.body ? String(init.body) : "";
    captured.contentType = init?.headers
      ? Array.isArray(init.headers)
        ? ""
        : (new Headers(init.headers).get("Content-Type") ?? "")
      : "";
    const text = options.json === false ? String(body) : JSON.stringify(body);
    return new Response(text, {
      status,
      headers: { "Content-Type": options.json === false ? "text/plain" : "application/json" },
    });
  }) as typeof fetch;
  return captured;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  // Reset store state after each test
  sessions.account = null;
  sessions.avatar = null;
});

describe("updateUserProfile", () => {
  test("calls PATCH /api/me with username and returns updated profile on 200", async () => {
    const captured = capture(200, { ok: true, username: "newusername", avatar: null });

    const result = await updateUserProfile({ username: "newusername" });

    expect(result).toEqual({ ok: true, username: "newusername", avatar: null });
    expect(captured.method).toBe("PATCH");
    expect(captured.url).toBe("/api/me");
    expect(captured.contentType).toBe("application/json");
    expect(JSON.parse(captured.body)).toEqual({ username: "newusername" });
  });

  test("calls PATCH /api/me with avatar and returns updated profile on 200", async () => {
    const captured = capture(200, {
      ok: true,
      username: "username",
      avatar: "data:image/png;base64,xyz",
    });

    const result = await updateUserProfile({ avatar: "data:image/png;base64,xyz" });

    expect(result).toEqual({ ok: true, username: "username", avatar: "data:image/png;base64,xyz" });
    expect(JSON.parse(captured.body)).toEqual({ avatar: "data:image/png;base64,xyz" });
  });

  test("calls PATCH /api/me with currentPassword and newPassword for password change", async () => {
    const captured = capture(200, { ok: true, username: "username", avatar: null });

    const result = await updateUserProfile({
      currentPassword: "oldpass123",
      newPassword: "newpass456",
    });

    expect(result).toEqual({ ok: true, username: "username", avatar: null });
    expect(JSON.parse(captured.body)).toEqual({
      currentPassword: "oldpass123",
      newPassword: "newpass456",
    });
  });

  test("calls PATCH /api/me with all fields combined", async () => {
    const captured = capture(200, { ok: true, username: "updateduser", avatar: "avatar-url" });

    const result = await updateUserProfile({
      username: "updateduser",
      avatar: "avatar-url",
      currentPassword: "current",
      newPassword: "new",
    });

    expect(result).toEqual({ ok: true, username: "updateduser", avatar: "avatar-url" });
    expect(JSON.parse(captured.body)).toEqual({
      username: "updateduser",
      avatar: "avatar-url",
      currentPassword: "current",
      newPassword: "new",
    });
  });

  test("returns error object on non-200 response with JSON error", async () => {
    capture(400, {
      error: { code: "VALIDATION_ERROR", message: "username is required" },
      requestId: "req-1",
    });

    const result = await updateUserProfile({ username: "" });

    expect(result).toEqual({ ok: false, error: "username is required" });
  });

  test("returns generic Vietnamese message on network failure", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const result = await updateUserProfile({ username: "test" });

    expect(result).toEqual({ ok: false, error: "Không kết nối được máy chủ." });
  });

  test("returns generic Vietnamese message on non-JSON response", async () => {
    capture(500, "internal server error", { json: false });

    const result = await updateUserProfile({ username: "test" });

    expect(result).toEqual({ ok: false, error: "Không kết nối được máy chủ." });
  });
});
