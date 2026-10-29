import { describe, expect, test } from "bun:test";
import { validateSetupForm } from "./setup-logic.ts";

/**
 * First-time setup validation rules (§19.1, Task 3).
 *
 * Pure rules shared between the form and its controller so the logic is testable
 * without a DOM:
 * - Username cannot be empty after trimming.
 * - Password must be at least 6 characters.
 * - Confirm password must match password.
 * Error copy is Vietnamese, matching the rest of the UI.
 */

describe("validateSetupForm", () => {
  test("rejects an empty username (after trimming)", () => {
    const result = validateSetupForm({
      username: "   ",
      password: "hunter2",
      confirmPassword: "hunter2",
    });

    expect(result).toEqual({
      valid: false,
      error: "Tên đăng nhập không được để trống.",
    });
  });

  test("rejects a username of only whitespace", () => {
    const result = validateSetupForm({
      username: "\t\n",
      password: "hunter2",
      confirmPassword: "hunter2",
    });

    expect(result).toEqual({
      valid: false,
      error: "Tên đăng nhập không được để trống.",
    });
  });

  test("rejects a password shorter than 6 characters", () => {
    const result = validateSetupForm({
      username: "ngotuananh2101",
      password: "12345",
      confirmPassword: "12345",
    });

    expect(result).toEqual({
      valid: false,
      error: "Mật khẩu phải có ít nhất 6 ký tự.",
    });
  });

  test("rejects mismatched passwords", () => {
    const result = validateSetupForm({
      username: "ngotuananh2101",
      password: "hunter2",
      confirmPassword: "hunter3",
    });

    expect(result).toEqual({
      valid: false,
      error: "Mật khẩu xác nhận không khớp.",
    });
  });

  test("accepts valid credentials", () => {
    const result = validateSetupForm({
      username: "ngotuananh2101",
      password: "hunter2",
      confirmPassword: "hunter2",
    });

    expect(result).toEqual({ valid: true });
  });

  test("accepts a username that has surrounding whitespace (it gets trimmed)", () => {
    const result = validateSetupForm({
      username: "  ngotuananh2101  ",
      password: "hunter2",
      confirmPassword: "hunter2",
    });

    expect(result).toEqual({ valid: true });
  });

  test("accepts exactly 6 characters for the password boundary", () => {
    const result = validateSetupForm({
      username: "ngotuananh2101",
      password: "123456",
      confirmPassword: "123456",
    });

    expect(result).toEqual({ valid: true });
  });

  test("reports the first failing rule (username before password)", () => {
    const result = validateSetupForm({
      username: "   ",
      password: "12",
      confirmPassword: "12",
    });

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Tên đăng nhập không được để trống.");
  });

  test("reports the first failing rule (password before confirm)", () => {
    const result = validateSetupForm({
      username: "ngotuananh2101",
      password: "12",
      confirmPassword: "different",
    });

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Mật khẩu phải có ít nhất 6 ký tự.");
  });
});
