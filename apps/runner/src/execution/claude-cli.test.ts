import { describe, expect, test } from "bun:test";
import {
  type ClaudeCliInput,
  compareVersions,
  hostClaudeCli,
  installGuidance,
  parseCliVersion,
  resolveClaudeCli,
  skippedCheckWarning,
} from "./claude-cli.ts";

const MIN = "2.1.309";

function input(overrides: Partial<ClaudeCliInput> = {}): ClaudeCliInput {
  const base = {
    env: {},
    home: "/home/op",
    platform: "linux",
    which: () => undefined,
    exists: () => false,
    versionOf: () => "2.1.400 (Claude Code)",
  };
  // The union's embedded arm requires a path; the one embedded test supplies
  // its own.
  return overrides.kind === "embedded"
    ? {
        ...base,
        ...overrides,
        kind: "embedded",
        embeddedPath: overrides.embeddedPath ?? "/tmp/claude-extracted",
      }
    : { ...base, ...overrides, kind: "external" };
}

describe("parseCliVersion", () => {
  test("reads the triple out of the CLI's version line", () => {
    expect(parseCliVersion("2.1.322 (Claude Code)\n")).toBe("2.1.322");
    expect(parseCliVersion("2.0.1")).toBe("2.0.1");
  });

  test("garbage output counts as unusable", () => {
    expect(parseCliVersion("")).toBeUndefined();
    expect(parseCliVersion("command not found")).toBeUndefined();
  });
});

describe("compareVersions", () => {
  test("compares numerically, not lexically", () => {
    expect(compareVersions("2.1.309", "2.1.309")).toBe(0);
    expect(compareVersions("2.1.400", "2.1.309")).toBe(1);
    expect(compareVersions("2.1.99", "2.1.309")).toBe(-1);
    expect(compareVersions("2.10.0", "2.9.99")).toBe(1);
  });
});

describe("resolveClaudeCli", () => {
  test("embedded builds answer the extracted path and probe nothing", () => {
    const result = resolveClaudeCli(
      input({
        kind: "embedded",
        embeddedPath: "/tmp/claude-extracted",
        which: () => {
          throw new Error("must not probe");
        },
      }),
    );
    expect(result).toEqual({ ok: true, mode: "embedded", path: "/tmp/claude-extracted" });
  });

  test("an explicit CC_WEB_CLAUDE_BIN wins over PATH", () => {
    const result = resolveClaudeCli(
      input({
        env: { CC_WEB_CLAUDE_BIN: "/opt/claude/bin/claude" },
        exists: (p) => p === "/opt/claude/bin/claude",
        which: () => "/usr/bin/claude",
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      mode: "external",
      path: "/opt/claude/bin/claude",
      version: "2.1.400",
    });
  });

  test("a bad CC_WEB_CLAUDE_BIN is refused, never bypassed", () => {
    const result = resolveClaudeCli(
      input({ env: { CC_WEB_CLAUDE_BIN: "/nope/claude" }, which: () => "/usr/bin/claude" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("override-invalid");
    expect(result.guidance).toContain("CC_WEB_CLAUDE_BIN");
  });

  test("a bare command CC_WEB_CLAUDE_BIN resolves through which", () => {
    const result = resolveClaudeCli(
      input({
        env: { CC_WEB_CLAUDE_BIN: "my-claude" },
        which: (name) => (name === "my-claude" ? "/custom/bin/my-claude" : undefined),
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      mode: "external",
      path: "/custom/bin/my-claude",
      version: "2.1.400",
    });
  });

  test("a bare command CC_WEB_CLAUDE_BIN that resolves to nothing fails as override-invalid", () => {
    const result = resolveClaudeCli(
      input({
        env: { CC_WEB_CLAUDE_BIN: "missing-claude" },
        which: () => undefined,
        exists: () => false,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("override-invalid");
    expect(result.guidance).toContain("CC_WEB_CLAUDE_BIN");
  });

  test("a bare command CC_WEB_CLAUDE_BIN resolves through exists when which misses", () => {
    const result = resolveClaudeCli(
      input({
        env: { CC_WEB_CLAUDE_BIN: "local-claude" },
        which: () => undefined,
        exists: (p) => p === "local-claude",
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      mode: "external",
      path: "local-claude",
      version: "2.1.400",
    });
  });

  test("PATH answers when no override is set", () => {
    const result = resolveClaudeCli(input({ which: () => "/usr/local/bin/claude" }));
    expect(result).toMatchObject({ ok: true, path: "/usr/local/bin/claude" });
  });

  test("finds the native installer's binary when PATH lacks it", () => {
    // systemd starts services with PATH=/usr/bin:/bin; the native installer
    // puts the launcher in ~/.local/bin.
    const result = resolveClaudeCli(input({ exists: (p) => p === "/home/op/.local/bin/claude" }));
    expect(result).toMatchObject({ ok: true, path: "/home/op/.local/bin/claude" });
  });

  test("finds the Windows native install under the user profile", () => {
    const result = resolveClaudeCli(
      input({
        platform: "win32",
        home: "C:\\Users\\op",
        exists: (p) => p === "C:\\Users\\op\\.local\\bin\\claude.exe",
      }),
    );
    expect(result).toMatchObject({ ok: true, path: "C:\\Users\\op\\.local\\bin\\claude.exe" });
  });

  test("an MSYS HOME still finds the native install under the profile", () => {
    // Git Bash exports HOME=/c/Users/op; win32.join would produce
    // "\c\Users\op\.local\bin\claude.exe", so the native binary is never found
    // and a host that can run is refused.
    const native = "C:\\Users\\op\\.local\\bin\\claude.exe";
    const result = resolveClaudeCli(
      input({
        platform: "win32",
        home: "/c/Users/op",
        which: () => "C:\\Users\\op\\AppData\\Roaming\\npm\\claude.cmd",
        exists: (p) => p === native,
      }),
    );
    expect(result).toMatchObject({ ok: true, path: native });
  });

  test("USERPROFILE wins over an MSYS HOME", () => {
    const native = "C:\\Users\\op\\.local\\bin\\claude.exe";
    const result = resolveClaudeCli(
      input({
        platform: "win32",
        home: "/c/Users/op",
        env: { USERPROFILE: "C:\\Users\\op" },
        exists: (p) => p === native,
      }),
    );
    expect(result).toMatchObject({ ok: true, path: native });
  });

  test("nothing found is a missing CLI with install guidance", () => {
    const result = resolveClaudeCli(input());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing");
    expect(result.guidance).toContain("https://claude.ai/install.sh");
  });

  test("a PATH shim alone is refused, naming the shim rather than the override", () => {
    // The SDK spawns the path as a native binary; an npm shim is a batch file.
    // No override was set, so the guidance must not talk about CC_WEB_CLAUDE_BIN.
    const result = resolveClaudeCli(
      input({ platform: "win32", which: () => "C:\\Users\\op\\AppData\\Roaming\\npm\\claude.cmd" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("shim-found");
    expect(result.guidance).toContain("claude.exe");
    expect(result.guidance).not.toContain("Ensure CC_WEB_CLAUDE_BIN");
  });

  test("a PATH shim falls through to the native install in a standard location", () => {
    // `npm install -g` puts a .cmd on PATH; the install command we print also
    // lays down a native claude.exe. Refusing on the shim alone would reject a
    // host that is perfectly able to run.
    const native = "C:\\Users\\op\\.local\\bin\\claude.exe";
    const result = resolveClaudeCli(
      input({
        platform: "win32",
        home: "C:\\Users\\op",
        which: () => "C:\\Users\\op\\AppData\\Roaming\\npm\\claude.cmd",
        exists: (p) => p === native,
      }),
    );
    expect(result).toMatchObject({ ok: true, path: native });
  });

  test("shims with varying casing like .BAT are refused", () => {
    const result = resolveClaudeCli(
      input({ platform: "win32", which: () => "C:\\Tools\\claude.BAT" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("shim-found");
    expect(result.guidance).toContain("claude.exe");
  });

  test("an older CLI is refused with upgrade guidance", () => {
    const result = resolveClaudeCli(
      input({ which: () => "/usr/bin/claude", versionOf: () => "2.1.100 (Claude Code)" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-old");
    expect(result.path).toBe("/usr/bin/claude");
    expect(result.guidance).toContain("claude update");
    expect(result.guidance).toContain(MIN);
  });

  test("probe output with unparseable garbage maps to too-old", () => {
    const result = resolveClaudeCli(
      input({ which: () => "/usr/bin/claude", versionOf: () => "not a valid version" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-old");
    expect(result.path).toBe("/usr/bin/claude");
  });

  test("a wrapper on PATH plus an unspawnable native binary names the wrapper", () => {
    // Uninstalling the native build leaves claude.exe behind; the probe then
    // reports no version. Plain "run claude update" sends the operator after
    // the wrong problem.
    const stale = "C:\\Users\\op\\.local\\bin\\claude.exe";
    const result = resolveClaudeCli(
      input({
        platform: "win32",
        home: "C:\\Users\\op",
        which: () => "C:\\Users\\op\\AppData\\Roaming\\npm\\claude.cmd",
        exists: (p) => p === stale,
        versionOf: () => undefined,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-old");
    expect(result.path).toBe(stale);
    expect(result.guidance).toContain("also on PATH");
    expect(result.guidance).toContain("claude update");
  });

  test("a hung or failed version probe is a failure, not a hang", () => {
    const result = resolveClaudeCli(
      input({ which: () => "/usr/bin/claude", versionOf: () => undefined }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-old");
    expect(result.path).toBe("/usr/bin/claude");
  });
});

describe("installGuidance", () => {
  test("names every supported install path and the override", () => {
    const text = installGuidance(MIN, "missing");
    expect(text).toContain("curl -fsSL https://claude.ai/install.sh | bash");
    expect(text).toContain("irm https://claude.ai/install.ps1 | iex");
    expect(text).toContain("npm install -g @anthropic-ai/claude-code");
    expect(text).toContain("CC_WEB_CLAUDE_BIN");
    expect(text).toContain(MIN);
  });

  test("the override and upgrade reasons say what to fix", () => {
    expect(installGuidance(MIN, "override-invalid")).toContain("CC_WEB_CLAUDE_BIN");
    expect(installGuidance(MIN, "too-old")).toContain("claude update");
  });

  test("npm is not offered on Windows, where it only leaves a wrapper behind", () => {
    // Following the npm line on Windows produces claude.cmd, which the next
    // run refuses as shim-found — the guidance would create its own problem.
    expect(installGuidance(MIN, "missing", { platform: "win32" })).not.toContain(
      "npm install -g @anthropic-ai/claude-code",
    );
    expect(installGuidance(MIN, "missing", { platform: "linux" })).toContain(
      "npm install -g @anthropic-ai/claude-code",
    );
    // No platform known (a bare call) keeps the full list.
    expect(installGuidance(MIN, "missing")).toContain("npm install -g @anthropic-ai/claude-code");
  });

  test("shim-found guidance explains the wrapper and points at the native build", () => {
    const text = installGuidance(MIN, "shim-found", { platform: "win32" });
    expect(text).toContain("claude.exe");
    expect(text).toContain("https://claude.ai/install.ps1");
    expect(text).not.toContain("Ensure CC_WEB_CLAUDE_BIN");
  });

  test("every refusal names the hatch that gets past it", () => {
    for (const reason of ["missing", "override-invalid", "too-old", "shim-found"] as const) {
      const text = installGuidance(MIN, reason);
      expect(text).toContain("--skip-cli-check");
      expect(text).toContain("CC_WEB_SKIP_CLI_CHECK=1");
    }
  });
});

describe("skippedCheckWarning", () => {
  test("keeps the diagnosis but drops the hatch the run already used", () => {
    const warning = skippedCheckWarning(installGuidance(MIN, "missing"));
    expect(warning.startsWith("warning: ")).toBe(true);
    expect(warning).toContain("was not found on PATH");
    expect(warning).not.toContain("To proceed anyway");
    expect(warning).not.toContain("--skip-cli-check");
  });

  test("a guidance with no hatch line is passed through whole", () => {
    expect(skippedCheckWarning("install claude first")).toBe("warning: install claude first");
  });
});

describe("hostClaudeCli", () => {
  test("answers a well-formed resolution in the host environment", () => {
    // Never throws, and the shape is one of the two arms. Which arm depends on
    // the shim on disk and the host's own `claude`, so both are valid here —
    // the per-shape behavior is covered by the injected tests above.
    const result = hostClaudeCli();
    if (result.ok) {
      expect(["embedded", "external"]).toContain(result.mode);
      expect(typeof result.path).toBe("string");
      return;
    }
    expect(["missing", "override-invalid", "too-old", "shim-found"]).toContain(result.reason);
    expect(typeof result.guidance).toBe("string");
  });
});
