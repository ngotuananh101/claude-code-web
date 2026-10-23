#!/usr/bin/env bun
/**
 * Static configuration doctor. Never calls a model (§8.3).
 *
 * Phase 0 will extend this into the compatibility probe: bundled CLI
 * resolution, config inheritance, provider auth presence, hooks/MCP reachability
 * and SDK version reporting. Until then it reports only what can be observed
 * locally without side effects.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Check = {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
};

/** Registration order is preserved for output, even though checks run concurrently. */
const order: string[] = [];
const results = new Map<string, Check>();
const pending: Promise<void>[] = [];

function check(
  name: string,
  run: () => Omit<Check, "name"> | Promise<Omit<Check, "name">>,
): void {
  order.push(name);
  pending.push(
    Promise.resolve()
      .then(run)
      .then((result) => {
        results.set(name, { name, ...result });
      })
      .catch((error: unknown) => {
        results.set(name, { name, status: "fail", detail: (error as Error).message });
      }),
  );
}

check("bun", () => ({
  status: "ok",
  detail: Bun.version,
}));

check("platform", () => ({
  status: "ok",
  detail: `${process.platform}/${process.arch}`,
}));

check("git", () => {
  const result = Bun.spawnSync(["git", "--version"]);
  if (result.exitCode !== 0) return { status: "warn", detail: "git not found on PATH" };
  return { status: "ok", detail: result.stdout.toString().trim() };
});

check("claude config dir", () => {
  const dir = process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
  if (!existsSync(dir)) {
    return { status: "warn", detail: `${dir} does not exist — no inherited config` };
  }
  return { status: "ok", detail: dir };
});

check("user settings", () => {
  const dir = process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
  const file = join(dir, "settings.json");
  return existsSync(file)
    ? { status: "ok", detail: file }
    : { status: "warn", detail: `${file} missing` };
});

check("provider auth", () => {
  // Presence only. Never print values, never claim the credential is valid.
  const present = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].filter(
    (key) => (process.env[key]?.length ?? 0) > 0,
  );
  if (present.length === 0) {
    return { status: "warn", detail: "no provider credential in environment" };
  }
  return { status: "ok", detail: `present: ${present.join(", ")}` };
});

check("provider endpoint", () => {
  const raw = process.env["ANTHROPIC_BASE_URL"];
  if (!raw) return { status: "ok", detail: "unset — SDK default (api.anthropic.com)" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { status: "fail", detail: "ANTHROPIC_BASE_URL is not a valid URL" };
  }

  const isLoopback = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(url.hostname);
  const isPrivate =
    isLoopback ||
    /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(url.hostname);
  const where = isLoopback ? "loopback" : isPrivate ? "private" : "public";

  // The bearer token is cleartext on the wire under plain http. Loopback is the
  // host itself, so there is no network hop; a private LAN still has other hosts
  // on the segment, so that is a warning rather than an outright failure.
  if (url.protocol === "http:") {
    if (!isPrivate) {
      return { status: "fail", detail: `plain http to ${where} host — token in cleartext` };
    }
    if (!isLoopback) {
      return {
        status: "warn",
        detail: `plain http to ${where} host — token readable on that network segment`,
      };
    }
  }
  return { status: "ok", detail: `${url.protocol}//${where} host` };
});

check("gateway reachable", async () => {
  const raw = process.env["ANTHROPIC_BASE_URL"];
  if (!raw) return { status: "ok", detail: "n/a" };
  try {
    // Any HTTP status proves something is listening; we assert reachability, not health.
    await fetch(raw, { method: "HEAD", signal: AbortSignal.timeout(2000) });
    return { status: "ok", detail: "listening" };
  } catch {
    return { status: "warn", detail: "not listening — start the gateway before Phase 0" };
  }
});

await Promise.all(pending);

const checks = order.map((name) => results.get(name)!);
const width = Math.max(...checks.map((c) => c.name.length));
for (const c of checks) {
  const mark = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗";
  console.log(`${mark} ${c.name.padEnd(width)}  ${c.detail}`);
}

const failed = checks.filter((c) => c.status === "fail").length;
process.exit(failed === 0 ? 0 : 1);
