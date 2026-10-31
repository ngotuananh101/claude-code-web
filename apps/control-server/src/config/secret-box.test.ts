import { describe, expect, test } from "bun:test";
import { createSecretBox } from "./secret-box.ts";

describe("secret-box", () => {
  test("round-trip: open(seal(plain)) returns the plaintext", () => {
    const box = createSecretBox(new Uint8Array(32).fill(7));
    const sealed = box.seal("sk-secret-key");
    expect(box.open(sealed)).toBe("sk-secret-key");
  });

  test("open returns null for a wrong key", () => {
    const alice = createSecretBox(new Uint8Array(32).fill(1));
    const bob = createSecretBox(new Uint8Array(32).fill(2));
    const sealed = alice.seal("sk-secret-key");
    expect(bob.open(sealed)).toBeNull();
  });

  test("open returns null for tampered ciphertext", () => {
    const box = createSecretBox(new Uint8Array(32).fill(3));
    const sealed = box.seal("sk-secret-key");
    // Flip a character in the ciphertext portion (the last segment).
    const parts = sealed.split(".");
    const ct = parts[3]!;
    const tampered = ct.replace(/./, ct[0] === "a" ? "b" : "a");
    const tamperedSealed = `${parts[0]}.${parts[1]}.${parts[2]}.${tampered}`;
    expect(box.open(tamperedSealed)).toBeNull();
  });

  test("two seals of the same plaintext differ (random IV per seal)", () => {
    const box = createSecretBox(new Uint8Array(32).fill(4));
    const a = box.seal("sk-secret-key");
    const b = box.seal("sk-secret-key");
    expect(a).not.toBe(b);
    expect(box.open(a)).toBe("sk-secret-key");
    expect(box.open(b)).toBe("sk-secret-key");
  });

  test("open returns null for malformed input", () => {
    const box = createSecretBox(new Uint8Array(32).fill(5));
    expect(box.open("not-a-valid-seal")).toBeNull();
    expect(box.open("v1.foo.bar")).toBeNull();
    expect(box.open("v1..")).toBeNull();
    expect(box.open("")).toBeNull();
  });

  test("open returns null for a wrong version prefix", () => {
    const box = createSecretBox(new Uint8Array(32).fill(6));
    const sealed = box.seal("sk-secret-key");
    const badVersion = sealed.replace(/^v1\./, "v2.");
    expect(box.open(badVersion)).toBeNull();
  });

  test("empty plaintext round-trips", () => {
    const box = createSecretBox(new Uint8Array(32).fill(8));
    const sealed = box.seal("");
    expect(sealed).toMatch(/^v1\./);
    expect(box.open(sealed)).toBe("");
  });
});
