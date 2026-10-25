import { describe, expect, test } from "bun:test";
import { controlUrlFromServer, resolveServerUrl, runSetup } from "./setup.ts";

/**
 * Connector setup (§6.1): the operator mints a token on the web and hands it
 * to `setup` out of band. URL and runner id are not secrets — argv is fine.
 * The token is, so it arrives by env, TTY or stdin and is never echoed back.
 */

describe("controlUrlFromServer", () => {
  test("derives the runner WebSocket endpoint from the server origin", () => {
    expect(controlUrlFromServer("http://localhost:8787")).toBe("ws://localhost:8787/ws/runner");
    expect(controlUrlFromServer("https://cc.example.com")).toBe("wss://cc.example.com/ws/runner");
    // A trailing slash on the operator-pasted origin must not double up.
    expect(controlUrlFromServer("http://localhost:8787/")).toBe("ws://localhost:8787/ws/runner");
  });

  test("refuses a URL that is not an http(s) origin", () => {
    expect(controlUrlFromServer("ftp://nope")).toBeUndefined();
    expect(controlUrlFromServer("not a url")).toBeUndefined();
  });
});

describe("resolveServerUrl", () => {
  test("an explicit --server flag wins over the compile-time default", () => {
    expect(resolveServerUrl("http://flag:8787", "https://baked.example.com")).toBe(
      "http://flag:8787",
    );
  });

  test("the baked default answers when no flag arrived", () => {
    expect(resolveServerUrl(undefined, "https://baked.example.com")).toBe(
      "https://baked.example.com",
    );
  });

  test("neither side offers anything — setup must refuse, not guess", () => {
    expect(resolveServerUrl(undefined, undefined)).toBe("");
    // Whitespace is nothing wearing a URL's clothes.
    expect(resolveServerUrl("   ", "  ")).toBe("");
  });
});

describe("runSetup", () => {
  const dir = "/tmp/fake-runner-home";

  test("saves the identity with the derived endpoint and the token as credential", async () => {
    const saved: Array<{ dir: string; identity: Record<string, string> }> = [];
    const result = await runSetup(
      {
        serverUrl: "http://localhost:8787",
        runnerId: "0e2ed34a-6b1e-4a55-b2cf-1c8e0fd6f3a1",
        token: "9f1c3b2a-1111-4c22-8d33-9e4455667788",
        identityDir: dir,
      },
      {
        saveIdentity: (d, identity) => {
          saved.push({ dir: d, identity });
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.dir).toBe(dir);
    expect(saved[0]!.identity).toEqual({
      runnerId: "0e2ed34a-6b1e-4a55-b2cf-1c8e0fd6f3a1",
      controlUrl: "ws://localhost:8787/ws/runner",
      credential: "9f1c3b2a-1111-4c22-8d33-9e4455667788",
    });
  });

  test("a missing token is an error and writes nothing", async () => {
    let writes = 0;
    const result = await runSetup(
      {
        serverUrl: "http://localhost:8787",
        runnerId: "runner-id",
        token: undefined,
        identityDir: dir,
      },
      {
        saveIdentity: () => {
          writes += 1;
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(writes).toBe(0);
  });

  test("an empty token is treated like a missing one", async () => {
    const result = await runSetup(
      { serverUrl: "http://localhost:8787", runnerId: "r", token: "   ", identityDir: dir },
      { saveIdentity: () => {} },
    );

    expect(result.ok).toBe(false);
  });

  test("a bad server URL is an error before anything is written", async () => {
    let writes = 0;
    const result = await runSetup(
      { serverUrl: "nope", runnerId: "r", token: "t", identityDir: dir },
      {
        saveIdentity: () => {
          writes += 1;
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(writes).toBe(0);
  });

  test("no result or message ever contains the token", async () => {
    const token = "aaabbbbb-cccc-4ddd-8eee-ffff00001111";
    const bad = await runSetup(
      { serverUrl: "http://localhost:8787", runnerId: "r", token: "", identityDir: dir },
      { saveIdentity: () => {} },
    );
    const good = await runSetup(
      { serverUrl: "http://localhost:8787", runnerId: "r", token, identityDir: dir },
      { saveIdentity: () => {} },
    );

    expect(JSON.stringify(bad)).not.toContain(token);
    expect(JSON.stringify(good)).not.toContain(token);
  });
});
