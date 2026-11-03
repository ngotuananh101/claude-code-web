import { describe, expect, test } from "bun:test";
import { cookieSecureFlag } from "./auth-routes.ts";

describe("cookieSecureFlag", () => {
  test("https request url gets Secure", () => {
    const req = new Request("https://cc.example.test/auth/login");
    expect(cookieSecureFlag(req)).toBe("; Secure");
  });

  test("plain http request url gets no Secure flag", () => {
    const req = new Request("http://localhost:8787/auth/login");
    expect(cookieSecureFlag(req)).toBe("");
  });

  test("X-Forwarded-Proto https gets Secure even when the inner request is http", () => {
    const req = new Request("http://127.0.0.1:8787/auth/login", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(cookieSecureFlag(req)).toBe("; Secure");
  });

  test("env override wins over both", () => {
    const prev = process.env["CC_WEB_SECURE_COOKIES"];
    try {
      process.env["CC_WEB_SECURE_COOKIES"] = "true";
      expect(cookieSecureFlag(new Request("http://localhost/auth/login"))).toBe("; Secure");
      process.env["CC_WEB_SECURE_COOKIES"] = "false";
      expect(cookieSecureFlag(new Request("https://cc.example.test/auth/login"))).toBe("");
    } finally {
      if (prev === undefined) delete process.env["CC_WEB_SECURE_COOKIES"];
      else process.env["CC_WEB_SECURE_COOKIES"] = prev;
    }
  });
});
