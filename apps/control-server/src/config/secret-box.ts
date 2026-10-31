/**
 * AES-256-GCM seal for profile API keys (§18.1, P3-C Task 5b).
 *
 * One box is built from the server secret per boot. Each `seal` uses a fresh
 * random 12-byte IV so identical plaintexts never produce identical ciphertexts.
 * `open` never throws: malformed input, a wrong key, or a failed auth tag all
 * resolve to `null`, so a route can never leak a decryption error as an
 * exception across the boundary.
 *
 * Output format: `v1.<iv_b64url>.<tag_b64url>.<ct_b64url>`, where `tag` is the
 * 16-byte AES-GCM authentication tag.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/** A sealed/encapsulated secret that can be opened only with its key. */
export type SecretBox = {
  /** Encrypt a plaintext string, returning a `v1.…` envelope. */
  seal(plain: string): string;
  /** Decrypt an envelope; null on any failure (malformed, wrong key, tampered). */
  open(sealed: string): string | null;
};

const KEY_INFO = "profile-secrets:v1";

function deriveKey(secret: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "cc-web-secret-box", KEY_INFO, 32));
}

/** Base64url with no padding. */
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function parseB64url(input: string): Buffer | null {
  try {
    const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
    const cleaned = padded.replace(/-/g, "+").replace(/_/g, "/");
    const buf = Buffer.from(cleaned, "base64");
    if (buf.length === 0 && input.length > 0) return null;
    return buf;
  } catch {
    return null;
  }
}

export function createSecretBox(secret: Uint8Array): SecretBox {
  const aesKey = deriveKey(secret);

  return {
    seal(plain: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
      const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();

      return `v1.${b64url(iv)}.${b64url(tag)}.${b64url(ct)}`;
    },

    open(sealed: string): string | null {
      if (typeof sealed !== "string") return null;
      const parts = sealed.split(".");
      if (parts.length !== 4 || parts[0] !== "v1") return null;

      const iv = parseB64url(parts[1]!);
      const tag = parseB64url(parts[2]!);
      const ct = parseB64url(parts[3]!);
      if (iv === null || tag === null || ct === null) return null;
      if (iv.length !== 12 || tag.length !== 16) return null;

      try {
        const decipher = createDecipheriv("aes-256-gcm", aesKey, iv);
        decipher.setAuthTag(tag);
        const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
        return pt.toString("utf8");
      } catch {
        return null;
      }
    },
  };
}
