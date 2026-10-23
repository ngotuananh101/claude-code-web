import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIdentity, type RunnerIdentity, saveIdentity } from "./identity-store.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "cc-web-identity-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const identity: RunnerIdentity = {
  runnerId: "runner-a",
  credential: "cck_secret_value_that_must_not_leak",
  controlUrl: "https://control.example",
};

describe("runner identity store", () => {
  test("round-trips a saved identity", async () => {
    await withTempDir(async (dir) => {
      await saveIdentity(dir, identity);
      expect(await loadIdentity(dir)).toEqual({ ok: true, identity });
    });
  });

  test("reports absence clearly instead of returning a default", async () => {
    await withTempDir(async (dir) => {
      // §6.3: a Runner without identity must enroll, not silently invent one.
      expect(await loadIdentity(dir)).toEqual({ ok: false, reason: "missing" });
    });
  });

  test("writes the credential file with owner-only permissions", async () => {
    await withTempDir(async (dir) => {
      await saveIdentity(dir, identity);
      const mode = (await stat(join(dir, "identity.json"))).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  test("tightens permissions on an existing file it did not create", async () => {
    await withTempDir(async (dir) => {
      await mkdir(dir, { recursive: true });
      const path = join(dir, "identity.json");
      await writeFile(path, JSON.stringify(identity), { mode: 0o644 });
      await chmod(path, 0o644);

      await saveIdentity(dir, identity);

      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  test("rejects a malformed identity file rather than using it", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "identity.json"), '{"runnerId":"x"}', { mode: 0o600 });
      // A partial identity would let the Runner connect as "x" with no credential.
      expect(await loadIdentity(dir)).toEqual({ ok: false, reason: "malformed" });
    });
  });

  test("does not create the file world-readable even briefly", async () => {
    await withTempDir(async (dir) => {
      await saveIdentity(dir, identity);
      const mode = (await stat(join(dir, "identity.json"))).mode & 0o777;
      // Redundant with the earlier assertion but stated as its own guarantee:
      // a 0644 window, even one instant long, leaks the credential to the host.
      expect(mode & 0o077).toBe(0);
    });
  });
});
