import { describe, expect, test } from "bun:test";
import { hashPassword, verifyPassword } from "./password.ts";

/**
 * Password hashing (§19.1).
 *
 * The stored value is a maintained library's output, never hand-rolled. These
 * tests exist because the failure modes here are silent: a verify that returns
 * `true` for anything, or a hash that is actually the plaintext, looks fine in
 * a login flow where nobody tries the wrong password.
 */

describe("password hashing", () => {
  test("verifies the password it hashed", async () => {
    const hash = await hashPassword("correct horse battery staple");

    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  test("refuses a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");

    expect(await verifyPassword("correct horse battery stapl", hash)).toBe(false);
  });

  test("the stored value is an argon2id hash, not the password", async () => {
    const plain = "hunter2";
    const hash = await hashPassword(plain);

    // If this ever fails, every password is effectively stored in the clear.
    expect(hash).not.toContain(plain);
    expect(hash.startsWith("$argon2id$")).toBe(true);
  });

  test("the same password hashes differently each time", async () => {
    // A deterministic hash would let an attacker with the database see which
    // users share a password.
    const a = await hashPassword("hunter2");
    const b = await hashPassword("hunter2");

    expect(a).not.toBe(b);
    expect(await verifyPassword("hunter2", a)).toBe(true);
    expect(await verifyPassword("hunter2", b)).toBe(true);
  });

  test("a malformed stored hash is refused rather than throwing", async () => {
    // A corrupt row must not turn a login attempt into a 500: the caller gets
    // "no", which is the same answer a wrong password gets.
    expect(await verifyPassword("hunter2", "not-a-hash")).toBe(false);
    expect(await verifyPassword("hunter2", "")).toBe(false);
  });
});
