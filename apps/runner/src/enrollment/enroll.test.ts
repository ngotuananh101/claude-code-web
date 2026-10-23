import { describe, expect, test } from "bun:test";
import { enroll } from "./enroll.ts";

/**
 * `runner enroll` (§6.1).
 *
 * The interesting parts are not the happy path:
 *
 *  - the token is read from stdin or an environment variable, never argv, so it
 *    does not land in shell history or `ps`
 *  - a refused token is reported without echoing the token back
 *  - the identity is written `0600` and is complete, because a half-written
 *    identity makes the daemon fail later with a confusing message
 */

type Call = { url: string; body: unknown };

function fakeFetch(response: { status: number; body: unknown }): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "null")) });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const opts = (overrides: Partial<Parameters<typeof enroll>[0]> = {}) => ({
  controlUrl: "https://cc.example.test",
  token: "ccr_token",
  identityDir: "/tmp/does-not-matter",
  fetch: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch,
  saveIdentity: async () => {},
  ...overrides,
});

describe("runner enroll", () => {
  test("posts the token and returns the identity to save", async () => {
    const { fetch, calls } = fakeFetch({
      status: 200,
      body: { runnerId: "runner_1", credential: "cck_secret" },
    });

    const result = await enroll(opts({ fetch }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity).toEqual({
        runnerId: "runner_1",
        controlUrl: "https://cc.example.test",
        credential: "cck_secret",
      });
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://cc.example.test/api/runner-enroll");
    expect(calls[0]!.body).toEqual({ token: "ccr_token" });
  });

  test("the token travels in the body, never the URL", async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: { runnerId: "r", credential: "c" } });

    await enroll(opts({ fetch }));

    // A token in a query string is a token in every access log on the path.
    expect(calls[0]!.url).not.toContain("ccr_token");
  });

  test("saves the identity once the server accepts", async () => {
    const { fetch } = fakeFetch({
      status: 200,
      body: { runnerId: "runner_1", credential: "cck_s" },
    });
    const saved: unknown[] = [];

    await enroll(
      opts({
        fetch,
        saveIdentity: async (identity) => {
          saved.push(identity);
        },
      }),
    );

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ runnerId: "runner_1", credential: "cck_s" });
  });

  test("a refused token is reported without echoing it", async () => {
    const { fetch } = fakeFetch({ status: 401, body: { error: "unauthorized" } });

    const result = await enroll(opts({ fetch }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The message may be logged or shown; it must not contain the token.
      expect(result.message).not.toContain("ccr_token");
      expect(result.message).toContain("401");
    }
  });

  test("a saved identity is never written when the server refuses", async () => {
    const { fetch } = fakeFetch({ status: 401, body: {} });
    const saved: unknown[] = [];

    await enroll(
      opts({
        fetch,
        saveIdentity: async (identity) => {
          saved.push(identity);
        },
      }),
    );

    // Writing a partial identity here would make the next `runner run` fail
    // with "missing identity" instead of "enrollment was refused".
    expect(saved).toHaveLength(0);
  });

  test("a malformed success response is an error, not a partial identity", async () => {
    const { fetch } = fakeFetch({ status: 200, body: { runnerId: "runner_1" } });

    const result = await enroll(opts({ fetch }));

    expect(result.ok).toBe(false);
  });

  test("a network failure is reported, not thrown", async () => {
    const fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof globalThis.fetch;

    const result = await enroll(opts({ fetch }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("connection refused");
  });
});
