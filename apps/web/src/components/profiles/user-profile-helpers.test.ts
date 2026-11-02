import { describe, expect, test } from "bun:test";
import { validatePasswordChange, validateUsername } from "./user-profile-helpers.ts";

describe("validateUsername", () => {
  test("returns valid for valid usernames", () => {
    expect(validateUsername("john")).toEqual({ valid: true });
    expect(validateUsername("john_doe")).toEqual({ valid: true });
    expect(validateUsername("john.doe")).toEqual({ valid: true });
    expect(validateUsername("john-doe")).toEqual({ valid: true });
    expect(validateUsername("John123")).toEqual({ valid: true });
    expect(validateUsername("a".repeat(32))).toEqual({ valid: true });
  });

  test("returns error for empty username", () => {
    const result = validateUsername("");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("returns error for username too short", () => {
    const result = validateUsername("a");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("returns error for username too long", () => {
    const result = validateUsername("a".repeat(33));
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("returns error for username with invalid characters", () => {
    const invalidUsernames = [
      "john@doe",
      "john doe",
      "john#doe",
      "john$doe",
      "john%doe",
      "john^doe",
      "john&doe",
      "john*doe",
      "john(doe)",
      "john+doe",
      "john=doe",
      "john[doe]",
      "john{doe}",
      "john|doe",
      "john<doe>",
      "john?doe",
      "john:doe",
      "john;doe",
      "john'doe",
      'john"doe',
      "john`doe",
      "john~doe",
      "john!doe",
      "john@doe",
    ];
    for (const username of invalidUsernames) {
      const result = validateUsername(username);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    }
  });

  test("trims whitespace before validation", () => {
    expect(validateUsername("  john  ")).toEqual({ valid: true });
    // Single char with whitespace trims to 1 char - still invalid
    const resultSingle = validateUsername("  a  ");
    expect(resultSingle.valid).toBe(false);
    // 31 chars with whitespace trims to 31 chars - valid
    const result31 = validateUsername(`  ${"a".repeat(31)}  `);
    expect(result31.valid).toBe(true);
  });
});

describe("validatePasswordChange", () => {
  test("returns valid when all fields are empty", () => {
    expect(validatePasswordChange("", "", "")).toEqual({ valid: true });
  });

  test("returns valid when all fields are empty strings", () => {
    expect(validatePasswordChange("", "", "")).toEqual({ valid: true });
  });

  test("returns error when current password is empty but next/confirm are filled", () => {
    const result = validatePasswordChange("", "newpass123", "newpass123");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("returns error when next password is less than 8 characters", () => {
    const result = validatePasswordChange("current123", "short", "short");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("returns error when next and confirm don't match", () => {
    const result = validatePasswordChange("current123", "newpass123", "newpass456");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("returns valid when all fields are correctly filled", () => {
    const result = validatePasswordChange("current123", "newpass123", "newpass123");
    expect(result.valid).toBe(true);
  });

  test("trims whitespace from inputs", () => {
    const result = validatePasswordChange("  current123  ", "  newpass123  ", "  newpass123  ");
    expect(result.valid).toBe(true);
  });
});
