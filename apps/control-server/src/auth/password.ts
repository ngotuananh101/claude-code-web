/**
 * Password hashing (§19.1).
 *
 * Delegates to Bun's built-in `Bun.password`, which is argon2id. The rule is
 * that a maintained implementation does the hashing; nothing here constructs a
 * salt, picks parameters, or compares digests by hand.
 *
 * `verifyPassword` returns `false` for a malformed stored hash rather than
 * throwing. A corrupt row must read as "wrong password", not as a 500 that
 * tells the caller the account exists.
 */

/** The stored format is the library's; this module never parses it. */
export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: "argon2id" });
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!hash) return false;

  try {
    return await Bun.password.verify(plain, hash);
  } catch {
    // An unparseable hash is a data problem, not a credential. Answering "no"
    // keeps the login path uniform and leaks nothing.
    return false;
  }
}
