import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { en } from "../lib/i18n/locales/en.ts";
import { vi } from "../lib/i18n/locales/vi.ts";

/**
 * `bun test` runs without `@vue/compiler-sfc`, so the login SFC contract is
 * verified from source text and translation tables the same way
 * `ApprovalCard.test.ts` and `AgentToolStep.test.ts` pin view templates.
 */
const SOURCE = new URL("./LoginView.vue", import.meta.url).pathname;

describe("LoginView remember-me contract", () => {
  test("defaults rememberMe to false and includes it in the login request payload", () => {
    const source = readFileSync(SOURCE, "utf8");

    expect(source).toContain("const rememberMe = ref(false);");
    expect(source).toContain("username: username.value,");
    expect(source).toContain("password: password.value,");
    expect(source).toContain("rememberMe: rememberMe.value,");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
  });

  test("renders an accessible native checkbox between the password input and submit button", () => {
    const source = readFileSync(SOURCE, "utf8");
    const passwordIndex = source.indexOf('id="password"');
    const checkboxIndex = source.indexOf('id="remember-me"');
    const submitIndex = source.indexOf('type="submit"');

    expect(passwordIndex).toBeGreaterThan(-1);
    expect(checkboxIndex).toBeGreaterThan(passwordIndex);
    expect(submitIndex).toBeGreaterThan(checkboxIndex);

    expect(source).toContain('type="checkbox"');
    expect(source).toContain('v-model="rememberMe"');
    expect(source).toContain('for="remember-me"');
    expect(source).toContain('t("auth.rememberMe")');
  });

  test("defines the 30-day rememberMe copy in both locales", () => {
    expect((en.auth as Record<string, string>)["rememberMe"]).toBe("Remember me for 30 days");
    expect((vi.auth as Record<string, string>)["rememberMe"]).toBe(
      "Ghi nhớ đăng nhập trong 30 ngày",
    );
  });
});
