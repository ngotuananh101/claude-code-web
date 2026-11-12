import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { claudeCliKind, embeddedCliPath, MIN_CLAUDE_CLI_VERSION } from "@cc-web/agent-adapter";

export type ClaudeCliResolution =
  | { ok: true; mode: "embedded" | "external"; path: string; version?: string }
  | { ok: false; reason: "missing" | "override-invalid" | "too-old"; guidance: string };

export type ClaudeCliInput = {
  kind: "embedded" | "external";
  embeddedPath?: string | undefined;
  env: Record<string, string | undefined>;
  home: string;
  platform: string;
  which: (name: string) => string | undefined;
  exists: (path: string) => boolean;
  versionOf: (path: string) => string | undefined;
};

/**
 * Extract the numeric semver triple (e.g. "2.1.309") from a CLI version output line.
 */
export function parseCliVersion(stdout: string): string | undefined {
  const match = stdout.match(/^(\d+\.\d+\.\d+)/m);
  return match ? match[1] : undefined;
}

/**
 * Compare two semver triples numerically segment-by-segment.
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareVersions(a: string, b: string): number {
  const segsA = a.split(".").map((s) => Number.parseInt(s, 10));
  const segsB = b.split(".").map((s) => Number.parseInt(s, 10));
  const len = Math.max(segsA.length, segsB.length);
  for (let i = 0; i < len; i++) {
    const na = segsA[i] ?? 0;
    const nb = segsB[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * Build install, override, or upgrade guidance text for CLI resolution failures.
 */
export function installGuidance(
  minimum: string,
  reason: "missing" | "override-invalid" | "too-old",
): string {
  switch (reason) {
    case "missing":
      return [
        `Claude Code CLI (version >= ${minimum}) was not found on PATH or standard install locations.`,
        "Install Claude Code using one of the following methods:",
        "  - macOS / Linux:  curl -fsSL https://claude.ai/install.sh | bash",
        "  - Windows:        irm https://claude.ai/install.ps1 | iex",
        "  - npm:            npm install -g @anthropic-ai/claude-code",
        "Alternatively, set CC_WEB_CLAUDE_BIN to the absolute path of the claude executable.",
      ].join("\n");
    case "override-invalid":
      return [
        "The configured Claude Code CLI executable is invalid or not spawnable.",
        "Ensure CC_WEB_CLAUDE_BIN points to an existing, executable binary.",
        "On Windows, .cmd, .bat, or .ps1 script shims are not supported directly; point directly to claude.exe instead.",
      ].join("\n");
    case "too-old":
      return [
        `Claude Code CLI is older than the required minimum version (${minimum}) or failed to report its version.`,
        `Please run 'claude update' or reinstall Claude Code to upgrade to >= ${minimum}.`,
      ].join("\n");
  }
}

function isShim(filePath: string): boolean {
  return /\.(cmd|ps1|bat)$/i.test(filePath);
}

/**
 * Pure resolver that determines which Claude CLI binary to use, based on
 * build kind (embedded vs external), environment override, PATH, and platform fallbacks.
 */
export function resolveClaudeCli(input: ClaudeCliInput): ClaudeCliResolution {
  if (input.kind === "embedded") {
    return { ok: true, mode: "embedded", path: input.embeddedPath! };
  }

  let chosenPath: string | undefined;

  const override = input.env["CC_WEB_CLAUDE_BIN"];
  if (override !== undefined) {
    const trimmed = override.trim();
    if (trimmed === "") {
      return {
        ok: false,
        reason: "override-invalid",
        guidance: installGuidance(MIN_CLAUDE_CLI_VERSION, "override-invalid"),
      };
    }

    const isBare = !trimmed.includes("/") && !trimmed.includes("\\");
    let candidate: string | undefined;
    if (isBare) {
      candidate = input.which(trimmed) ?? (input.exists(trimmed) ? trimmed : undefined);
    } else {
      candidate = input.exists(trimmed) ? trimmed : undefined;
    }

    if (!candidate || isShim(candidate)) {
      return {
        ok: false,
        reason: "override-invalid",
        guidance: installGuidance(MIN_CLAUDE_CLI_VERSION, "override-invalid"),
      };
    }

    chosenPath = candidate;
  }

  if (!chosenPath) {
    const fromWhich = input.which("claude");
    if (fromWhich !== undefined) {
      if (isShim(fromWhich)) {
        return {
          ok: false,
          reason: "override-invalid",
          guidance: installGuidance(MIN_CLAUDE_CLI_VERSION, "override-invalid"),
        };
      }
      chosenPath = fromWhich;
    }
  }

  if (!chosenPath) {
    const p = input.platform === "win32" ? win32 : posix;
    const fallbacks: string[] =
      input.platform === "win32"
        ? [
            p.join(input.home, ".local", "bin", "claude.exe"),
            p.join(
              input.env["LOCALAPPDATA"] ?? p.join(input.home, "AppData", "Local"),
              "Programs",
              "claude",
              "claude.exe",
            ),
          ]
        : [
            p.join(input.home, ".local", "bin", "claude"),
            p.join(input.home, ".claude", "local", "claude"),
            "/usr/local/bin/claude",
            "/opt/homebrew/bin/claude",
            "/usr/bin/claude",
          ];

    for (const candidate of fallbacks) {
      if (input.exists(candidate)) {
        chosenPath = candidate;
        break;
      }
    }
  }

  if (!chosenPath) {
    return {
      ok: false,
      reason: "missing",
      guidance: installGuidance(MIN_CLAUDE_CLI_VERSION, "missing"),
    };
  }

  const rawVersion = input.versionOf(chosenPath);
  if (!rawVersion) {
    return {
      ok: false,
      reason: "too-old",
      guidance: installGuidance(MIN_CLAUDE_CLI_VERSION, "too-old"),
    };
  }

  const version = parseCliVersion(rawVersion);
  if (!version) {
    return {
      ok: false,
      reason: "too-old",
      guidance: installGuidance(MIN_CLAUDE_CLI_VERSION, "too-old"),
    };
  }

  if (compareVersions(version, MIN_CLAUDE_CLI_VERSION) < 0) {
    return {
      ok: false,
      reason: "too-old",
      guidance: installGuidance(MIN_CLAUDE_CLI_VERSION, "too-old"),
    };
  }

  return {
    ok: true,
    mode: "external",
    path: chosenPath,
    version,
  };
}

/**
 * Production wiring: resolves host Claude Code CLI by reading process environment
 * and querying host system dependencies lazily.
 */
export function hostClaudeCli(
  env: Record<string, string | undefined> = process.env,
): ClaudeCliResolution {
  return resolveClaudeCli({
    kind: claudeCliKind(),
    embeddedPath: embeddedCliPath(),
    env,
    home: env["HOME"] ?? env["USERPROFILE"] ?? homedir(),
    platform: process.platform,
    which: (name: string) => Bun.which(name) ?? undefined,
    exists: (p: string) => existsSync(p),
    versionOf: (path: string) => {
      try {
        const r = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 5000 });
        if (r.error || r.status !== 0 || !r.stdout) {
          return undefined;
        }
        return parseCliVersion(r.stdout);
      } catch {
        return undefined;
      }
    },
  });
}
