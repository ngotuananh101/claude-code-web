import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { claudeCliKind, embeddedCliPath, MIN_CLAUDE_CLI_VERSION } from "@cc-web/agent-adapter";

export type ClaudeCliResolution =
  | { ok: true; mode: "embedded" | "external"; path: string; version?: string }
  | {
      ok: false;
      reason: "missing" | "override-invalid" | "too-old" | "shim-found";
      guidance: string;
      /** Set for "too-old": the CLI was found, just below the floor. */
      path?: string;
    };

export type ClaudeCliInput = (
  | { kind: "embedded"; embeddedPath: string }
  | { kind: "external"; embeddedPath?: string | undefined }
) & {
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
 *
 * One shared body with a per-reason first line, and every text ends with the
 * skip hatch: the refusal is useless to an operator who cannot get past it.
 */
export function installGuidance(
  minimum: string,
  reason: "missing" | "override-invalid" | "too-old" | "shim-found",
): string {
  const head =
    reason === "missing"
      ? `Claude Code CLI (version >= ${minimum}) was not found on PATH or standard install locations.`
      : reason === "override-invalid"
        ? "The configured Claude Code CLI executable is invalid or not spawnable."
        : reason === "shim-found"
          ? `Only script shims for Claude Code were found (version >= ${minimum} required), and the SDK cannot spawn those as a native binary.`
          : `Claude Code CLI is older than the required minimum version (${minimum}) or failed to report its version.`;

  const body: string[] = [];
  if (reason === "missing") {
    body.push(
      "Install Claude Code using one of the following methods:",
      "  - macOS / Linux:  curl -fsSL https://claude.ai/install.sh | bash",
      "  - Windows:        irm https://claude.ai/install.ps1 | iex",
      "  - npm:            npm install -g @anthropic-ai/claude-code",
    );
  }
  if (reason === "override-invalid") {
    body.push(
      "Ensure CC_WEB_CLAUDE_BIN points to an existing, executable binary.",
      "On Windows, .cmd, .bat, or .ps1 script shims are not supported directly; point directly to claude.exe instead.",
    );
  }
  if (reason === "shim-found") {
    body.push(
      "An npm global install creates a .cmd/.ps1 wrapper, which is not a native executable.",
      "Install the native build so a claude.exe exists:",
      "  - Windows:        irm https://claude.ai/install.ps1 | iex",
      "Or point CC_WEB_CLAUDE_BIN at a native claude.exe directly.",
    );
  }
  if (reason === "too-old") {
    body.push(`Please run 'claude update' or reinstall Claude Code to upgrade to >= ${minimum}.`);
  }
  if (reason === "missing") {
    body.push(
      "Alternatively, set CC_WEB_CLAUDE_BIN to the absolute path of the claude executable.",
    );
  }
  body.push("To proceed anyway: --skip-cli-check (or CC_WEB_SKIP_CLI_CHECK=1).");
  return [head, ...body].join("\n");
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
    return { ok: true, mode: "embedded", path: input.embeddedPath };
  }

  let chosenPath: string | undefined;
  // A PATH wrapper seen on the way. It is a fall-through, not a hard failure:
  // `npm install -g` lays a .cmd/.ps1 wrapper on PATH, and the native installer
  // the guidance recommends puts a real claude.exe in a standard directory. A
  // host with both can run; only a host with the shim alone is refused.
  let sawShim: string | undefined;

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
      if (isShim(fromWhich)) sawShim = fromWhich;
      else chosenPath = fromWhich;
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
    if (sawShim !== undefined) {
      return {
        ok: false,
        reason: "shim-found",
        guidance: installGuidance(MIN_CLAUDE_CLI_VERSION, "shim-found"),
      };
    }
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
      path: chosenPath,
    };
  }

  const version = parseCliVersion(rawVersion);
  if (!version) {
    return {
      ok: false,
      reason: "too-old",
      guidance: installGuidance(MIN_CLAUDE_CLI_VERSION, "too-old"),
      path: chosenPath,
    };
  }

  if (compareVersions(version, MIN_CLAUDE_CLI_VERSION) < 0) {
    return {
      ok: false,
      reason: "too-old",
      guidance: installGuidance(MIN_CLAUDE_CLI_VERSION, "too-old"),
      path: chosenPath,
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
  const common = {
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
  };
  const kind = claudeCliKind();
  const embedded = embeddedCliPath();
  // claudeCliKind() and embeddedCliPath() both read the shim so they agree, but
  // the union's embedded arm needs the path narrowed to a string.
  if (kind === "embedded" && embedded !== undefined) {
    return resolveClaudeCli({ kind: "embedded", embeddedPath: embedded, ...common });
  }
  return resolveClaudeCli({ kind: "external", ...common });
}
