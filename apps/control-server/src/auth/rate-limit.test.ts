import { describe, expect, test } from "bun:test";
import { clientKey, createRateLimiter } from "./rate-limit.ts";

describe("rate limiter", () => {
  test("allows attempts up to the limit, then refuses", () => {
    const limiter = createRateLimiter(3, 60_000);
    expect(limiter.check("1.2.3.4")).toBe(true);
    expect(limiter.check("1.2.3.4")).toBe(true);
    expect(limiter.check("1.2.3.4")).toBe(true);
    expect(limiter.check("1.2.3.4")).toBe(false);
    // A different key has its own bucket.
    expect(limiter.check("5.6.7.8")).toBe(true);
  });

  test("old attempts fall out of the window", async () => {
    const limiter = createRateLimiter(1, 50);
    expect(limiter.check("1.2.3.4")).toBe(true);
    expect(limiter.check("1.2.3.4")).toBe(false);
    await Bun.sleep(60);
    expect(limiter.check("1.2.3.4")).toBe(true);
  });

  test("reset clears every bucket", () => {
    const limiter = createRateLimiter(1, 60_000);
    expect(limiter.check("1.2.3.4")).toBe(true);
    expect(limiter.check("1.2.3.4")).toBe(false);
    limiter.reset();
    expect(limiter.check("1.2.3.4")).toBe(true);
  });
});

describe("clientKey", () => {
  test("uses the first X-Forwarded-For entry", () => {
    const req = new Request("http://localhost/auth/login", {
      headers: { "x-forwarded-for": "203.0.113.9, 127.0.0.1" },
    });
    expect(clientKey(req)).toBe("203.0.113.9");
  });

  test("falls back to unknown without the header", () => {
    const req = new Request("http://localhost/auth/login");
    expect(clientKey(req)).toBe("unknown");
  });
});
