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

const checks: Check[] = [];

function check(name: string, run: () => Omit<Check, "name">): void {
  try {
    checks.push({ name, ...run() });
  } catch (error) {
    checks.push({ name, status: "fail", detail: (error as Error).message });
  }
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
  const present = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].filter(
    (key) => (process.env[key]?.length ?? 0) > 0,
  );
  if (present.length === 0) {
    return { status: "warn", detail: "no provider credential in environment" };
  }
  return { status: "ok", detail: `present: ${present.join(", ")}` };
});

const width = Math.max(...checks.map((c) => c.name.length));
for (const c of checks) {
  const mark = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗";
  console.log(`${mark} ${c.name.padEnd(width)}  ${c.detail}`);
}

const failed = checks.filter((c) => c.status === "fail").length;
process.exit(failed === 0 ? 0 : 1);
