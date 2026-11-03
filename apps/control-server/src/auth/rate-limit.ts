/**
 * A tiny in-memory rate limiter for unauthenticated auth endpoints.
 *
 * This is deliberately not a general-purpose limiter: it exists for
 * POST /auth/login and POST /auth/setup, where a correct password must
 * not be brute-forced at full speed. The bucket is per client key, with
 * a generous default (30 attempts per 15 minutes) so a single owner
 * never trips it by normal use, while an automated guessing loop hits
 * 429 quickly.
 *
 * Client key: the first X-Forwarded-For entry, falling back to "unknown".
 * In production the control server sits behind Caddy on loopback, so the
 * external TLS proxy is the one that should strip / set X-Forwarded-For.
 * A client that can talk directly to the control server (local dev) can
 * spoof this header and get a fresh bucket — that is a known limitation
 * of header-based keys, and it does not weaken the loopback deployment,
 * where only the proxy's traffic reaches the server.
 */

export type RateLimiter = {
  /** Returns true if this attempt is allowed, false if the bucket is full. */
  check(key: string): boolean;
  /** Clear all buckets (tests, and any future admin reset). */
  reset(): void;
};

export function createRateLimiter(limit = 30, windowMs = 15 * 60 * 1000): RateLimiter {
  const buckets = new Map<string, number[]>();
  return {
    check(key: string): boolean {
      const now = Date.now();
      const attempts = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
      if (attempts.length >= limit) {
        buckets.set(key, attempts);
        return false;
      }
      attempts.push(now);
      buckets.set(key, attempts);
      return true;
    },
    reset(): void {
      buckets.clear();
    },
  };
}

export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}
