# Runner CLI Variants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the runner be built either slim (no embedded Claude Code; uses the host's `claude`) or bundled (today's behavior), and refuse to configure or boot a slim runner when the host CLI is missing or too old.

**Architecture:** The build-time switch is a generated shim that either statically imports the SDK's platform binary (bundled) or exports nothing to import (slim) — the only way to keep ~293 MB out of the compiled executable. At runtime a pure, injected resolver in `apps/runner` finds the host CLI (`CC_WEB_CLAUDE_BIN` → `PATH` → well-known install dirs), gates it on `MIN_CLAUDE_CLI_VERSION`, and hands the single absolute path to the SDK adapter, the two boot probes, and the executor. `setup`, `connect` and `service install` refuse with install guidance unless `--skip-cli-check` is given.

**Tech Stack:** Bun 1.4.3, TypeScript 7 (`tsc -b`), `bun:test`, Biome, `@anthropic-ai/claude-agent-sdk@0.3.309` (bundles CLI 2.1.309).

**Spec:** `docs/superpowers/specs/2026-11-10-runner-cli-variant-design.md`

## Global Constraints

- Bun 1.4.3; no new dependencies — `Bun.which`, `node:child_process`, `node:fs` are enough.
- `packages/agent-adapter` stays the only module importing `@anthropic-ai/claude-agent-sdk` (§4.2).
- `packages/agent-adapter/src/claude-asset.generated.ts` is generated and gitignored; never edit it by hand, never commit it.
- `MIN_CLAUDE_CLI_VERSION` starts at exactly `2.1.309` (the CLI the installed SDK bundles).
- Slim is the default build; `--with-cli` opts into bundled. Artifact names: `cc-web-runner-<os>-<arch>` (slim), `cc-web-runner-bundled-<os>-<arch>` (bundled).
- Escape hatch everywhere the CLI is required: `--skip-cli-check` (flag) or `CC_WEB_SKIP_CLI_CHECK=1` (env).
- Override path: `CC_WEB_CLAUDE_BIN` — a bad value is a hard failure, never a fallback.
- All code, comments, docs and commit messages in English.
- If `bun` is not on `PATH`, use the installed binary path directly (this repo's tool shells have lacked it before); every verification command below assumes `bun` resolves.
- After each task: `bun test <paths>` must pass, and `bun run typecheck` must pass before the final commit of the task that changes types.

## Review Focus

1. A systemd service starts with `PATH=/usr/bin:/bin`, so `~/.local/bin/claude` is invisible — the resolver must still find the native install. (Task 3, `resolveClaudeCli` test "finds the native installer's binary when PATH lacks it".)
2. `CC_WEB_CLAUDE_BIN` points at a typo'd path — the runner must refuse, not quietly use a different CLI. (Task 3, test "a bad CC_WEB_CLAUDE_BIN is refused, never bypassed".)
3. An npm-installed CLI on Windows resolves to `claude.cmd`, which the SDK cannot spawn as a native binary — it must be rejected with guidance pointing at `CC_WEB_CLAUDE_BIN`. (Task 3, test "a .cmd/.ps1 shim is refused as spawnable").)
4. `claude --version` prints something unexpected or hangs — the resolver must treat that as "no usable CLI" and answer with guidance, never throw. (Task 3, tests "garbage --version output counts as unusable" and "a hung version probe is a failure, not a hang".)
5. A slim shim on a dev machine with no host CLI must not make `import` throw — module load stays pure and only the resolver reports the problem. (Task 1, `packages/agent-adapter/src/claude-asset.test.ts` "a slim build names no embedded path and import stays cheap".)

---

### Task 1: Two shim shapes and an adapter that tolerates both

**Files:**
- Modify: `scripts/claude-asset.ts`
- Modify: `packages/agent-adapter/src/claude-asset.ts`
- Modify: `packages/agent-adapter/src/index.ts:14-16,178-182`
- Modify: `apps/runner/src/execution/model-catalog.ts:24,67`
- Modify: `apps/runner/src/execution/capability-catalog.ts:24,100`
- Test: `scripts/claude-asset.test.ts`
- Test: `packages/agent-adapter/src/claude-asset.test.ts`
- Test: `packages/agent-adapter/src/index.test.ts`

**Interfaces:**
- Produces: `export type ClaudeAssetVariant = "slim" | "bundled"` and `generateShim(target: string, variant?: ClaudeAssetVariant): Promise<void>` in `scripts/claude-asset.ts` (default `"bundled"`).
- Produces: `claudeCliKind(): "embedded" | "external"` and `embeddedCliPath(): string | undefined` in `packages/agent-adapter/src/claude-asset.ts`.
- Produces: the generated shim exports `asset`, one of `{ kind: "embedded"; binPath: string }` or `{ kind: "external" }`.
- Note: `claudeCliPath()` is removed and its two callers are updated in this task with the minimal fix (embed-or-omit), so every commit stays green. Task 5 later replaces that minimal fix with the resolved-path option.

- [ ] **Step 1: Write the failing test for both shim shapes**

Replace `scripts/claude-asset.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { claudeAssetTarget } from "../packages/agent-adapter/src/claude-asset-targets.ts";
import { generateShim } from "./claude-asset.ts";

const SHIM_PATH = new URL(
  "../packages/agent-adapter/src/claude-asset.generated.ts",
  import.meta.url,
).pathname;

describe("generateShim", () => {
  test("bundled shim names the host target's binary as a file asset", async () => {
    const pending = generateShim("host", "bundled");
    expect(pending).toBeInstanceOf(Promise);
    await pending;
    const asset = claudeAssetTarget("host");
    const shim = readFileSync(SHIM_PATH, "utf8");
    expect(shim).toContain(`import binPath from "${asset.pkg}/${asset.binary}"`);
    expect(shim).toContain('kind: "embedded"');
  });

  test("slim shim imports no platform package at all", async () => {
    await generateShim("host", "slim");
    const shim = readFileSync(SHIM_PATH, "utf8");
    expect(shim).toContain('kind: "external"');
    // A single static import is enough to pull 293 MB into the executable.
    expect(shim).not.toContain("@anthropic-ai/claude-agent-sdk-");
    expect(shim).not.toContain("with { type: \"file\" }");
  });

  test("the variant defaults to bundled", async () => {
    await generateShim("host");
    expect(readFileSync(SHIM_PATH, "utf8")).toContain('kind: "embedded"');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test scripts/claude-asset.test.ts`
Expected: FAIL — `generateShim` ignores the second argument and writes a default export.

- [ ] **Step 3: Write the two shim shapes in `scripts/claude-asset.ts`**

Change the exported signature and body (keep the file's existing header comment, updating the variant sentence):

```ts
export type ClaudeAssetVariant = "slim" | "bundled";

export async function generateShim(target: string, variant: ClaudeAssetVariant = "bundled"): Promise<void> {
  if (variant === "slim") {
    await Bun.write(
      SHIM_PATH,
      `// GENERATED by scripts/claude-asset.ts — do not edit, do not commit.
// Slim build: no CLI is embedded; the runner uses the host's \`claude\`.
export const asset = { kind: "external" } as const;
`,
    );
    return;
  }
  const asset = claudeAssetTarget(target);
  await Bun.write(
    SHIM_PATH,
    `// GENERATED by scripts/claude-asset.ts — do not edit, do not commit.
// Regenerated on every \`bun install\` (postinstall) and every \`build:runner\`.
import binPath from "${asset.pkg}/${asset.binary}" with { type: "file" };
export const asset = { kind: "embedded", binPath } as const;
`,
  );
}
```

The `if (import.meta.main)` block keeps working unchanged (it calls `generateShim(target)`).

- [ ] **Step 4: Rewrite `packages/agent-adapter/src/claude-asset.ts`**

```ts
/**
 * Where this build's Claude Code CLI comes from (§20.3).
 *
 * `bundled` builds embed the SDK's platform binary as a file asset and extract
 * it at first use — a `bun build --compile` binary cannot resolve the CLI
 * inside `$bunfs`. `slim` builds embed nothing and use the host's own `claude`
 * (resolved by apps/runner/src/execution/claude-cli.ts).
 *
 * The generated shim is the switch: importing the platform package is what
 * pulls ~293 MB into the executable, so the slim shim has no such import.
 */

import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import { asset } from "./claude-asset.generated.ts";

export function claudeCliKind(): "embedded" | "external" {
  return asset.kind === "embedded" ? "embedded" : "external";
}

/** The extracted path of the embedded CLI; `undefined` in a slim build. */
export function embeddedCliPath(): string | undefined {
  return asset.kind === "embedded" ? extractFromBunfs(asset.binPath) : undefined;
}
```

- [ ] **Step 5: Update `packages/agent-adapter/src/index.ts`**

Replace the `claudeCliPath` import/export with `claudeCliKind` and `embeddedCliPath`, and change the option assignment so an unknown path is **omitted**:

```ts
import { claudeCliKind, embeddedCliPath } from "./claude-asset.ts";

export { claudeCliKind, embeddedCliPath } from "./claude-asset.ts";
```

```ts
  // §20.3: a bundled build always names its extracted CLI; a slim build names
  // nothing and lets the caller (the runner's resolver) supply the host's.
  const cliPath = input.pathToClaudeCodeExecutable ?? embeddedCliPath();
  if (cliPath !== undefined) options["pathToClaudeCodeExecutable"] = cliPath;
```

Update the doc comment on `pathToClaudeCodeExecutable` to say the default is the embedded asset when the build has one.

- [ ] **Step 6: Update `packages/agent-adapter/src/claude-asset.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { claudeCliKind, embeddedCliPath } from "./claude-asset.ts";

describe("the build's CLI source", () => {
  test("an embedded build extracts a binary that exists on this host", () => {
    if (claudeCliKind() !== "embedded") return;
    const path = embeddedCliPath();
    expect(path).toBeDefined();
    expect(existsSync(path!)).toBe(true);
  });

  test("a slim build names no embedded path and import stays cheap", () => {
    if (claudeCliKind() !== "external") return;
    expect(embeddedCliPath()).toBeUndefined();
  });
});
```

- [ ] **Step 7: Update `packages/agent-adapter/src/index.test.ts`**

Replace the test `defaults the CLI path to the resolved asset` with:

```ts
  test("defaults the CLI path to the embedded asset when the build has one", () => {
    // §20.3: a bundled build always sets the option; a slim build omits it so
    // the runner's resolver supplies the host path.
    const value = captureOptions({ prompt: "hi", cwd: "/w" }).options?.["pathToClaudeCodeExecutable"];
    expect(value).toBe(embeddedCliPath());
    if (embeddedCliPath() === undefined) {
      expect(captureOptions({ prompt: "hi", cwd: "/w" }).options !== undefined &&
        "pathToClaudeCodeExecutable" in captureOptions({ prompt: "hi", cwd: "/w" }).options!).toBe(false);
    }
  });
```

Change the import line at the top from `claudeCliPath` to `embeddedCliPath`.

- [ ] **Step 8: Run the tests**

Run: `bun test scripts/claude-asset.test.ts packages/agent-adapter/src`
Expected: PASS (with the bundled shim from the previous step; the last `generateShim("host")` call in the test leaves it bundled).

- [ ] **Step 9: Apply the minimal fix to the two catalog callers**

Both probes call `claudeCliPath()` today. Replace the import with `embeddedCliPath` and the option line with:

```ts
        ...(embeddedCliPath() === undefined
          ? {}
          : { pathToClaudeCodeExecutable: embeddedCliPath() }),
```

in `apps/runner/src/execution/model-catalog.ts` and `apps/runner/src/execution/capability-catalog.ts`. (Task 5 replaces this with the runner-resolved path.)

- [ ] **Step 10: Verify no stale references and every test still loads**

Run: `grep -rn "claudeCliPath" --include=*.ts apps packages scripts | grep -v node_modules`
Expected: no output.

Run: `bun test packages/agent-adapter/src scripts/claude-asset.test.ts apps/runner/src/execution/model-catalog.test.ts apps/runner/src/execution/capability-catalog.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add scripts/claude-asset.ts scripts/claude-asset.test.ts \
  packages/agent-adapter/src/claude-asset.ts packages/agent-adapter/src/claude-asset.test.ts \
  packages/agent-adapter/src/index.ts packages/agent-adapter/src/index.test.ts \
  apps/runner/src/execution/model-catalog.ts apps/runner/src/execution/capability-catalog.ts
git commit -m "feat(agent-adapter): generate bundled or slim CLI shims"
```

---

### Task 2: `build:runner --with-cli`, slim by default

**Files:**
- Create: `packages/agent-adapter/src/claude-cli-version.ts`
- Create: `packages/agent-adapter/src/claude-cli-version.test.ts`
- Modify: `scripts/build-runner.ts:26-52,54-66`
- Test: `scripts/build-runner.test.ts`

**Interfaces:**
- Consumes: `generateShim(target, variant)` from Task 1.
- Produces: `export const MIN_CLAUDE_CLI_VERSION = "2.1.309"` in `packages/agent-adapter/src/claude-cli-version.ts` — consumed by Task 3.
- Produces: `BuildArgs = { target: string; outfile: string; defines: string[]; variant: "slim" | "bundled" }`; `--with-cli` sets `variant: "bundled"`.

- [ ] **Step 1: Write the failing test for the version floor**

Create `packages/agent-adapter/src/claude-cli-version.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MIN_CLAUDE_CLI_VERSION } from "./claude-cli-version.ts";

describe("MIN_CLAUDE_CLI_VERSION", () => {
  test("matches the CLI version the installed SDK bundles", () => {
    // SDK 0.3.x bundles CLI 2.1.x in lockstep; the SDK's own manifest records
    // it. A dependency bump that forgets this constant would let the runner
    // accept a CLI missing options the adapter sets.
    const manifestUrl = new URL(
      "../../../node_modules/@anthropic-ai/claude-agent-sdk/manifest.json",
      import.meta.url,
    );
    const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as { version?: string };
    expect(typeof manifest.version).toBe("string");
    expect(MIN_CLAUDE_CLI_VERSION).toBe(manifest.version);
  });

  test("is a plain x.y.z triple", () => {
    expect(MIN_CLAUDE_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/agent-adapter/src/claude-cli-version.test.ts`
Expected: FAIL — cannot resolve `./claude-cli-version.ts`.

- [ ] **Step 3: Create the module**

```ts
/**
 * The oldest Claude Code CLI a slim runner accepts.
 *
 * The Agent SDK and the CLI it bundles release in lockstep (SDK 0.3.309 ships
 * CLI 2.1.309, per the SDK's own manifest.json), and the adapter sets options
 * — `effort`, `forwardSubagentText` — that older CLIs do not understand. A
 * host CLI newer than this floor is normal (native installs auto-update) and
 * is accepted; only older is refused.
 *
 * `claude-cli-version.test.ts` compares this constant with the installed SDK's
 * manifest, so an SDK bump that forgets it fails the suite instead of shipping.
 */
export const MIN_CLAUDE_CLI_VERSION = "2.1.309";
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `bun test packages/agent-adapter/src/claude-cli-version.test.ts`
Expected: PASS.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/build-runner.test.ts`:

```ts
describe("variant selection", () => {
  test("slim is the default build", () => {
    expect(parseArgs([]).variant).toBe("slim");
  });

  test("--with-cli asks for the bundled build", () => {
    expect(parseArgs(["--with-cli"]).variant).toBe("bundled");
  });

  test("--with-cli combines with the release workflow's flags", () => {
    expect(parseArgs(["--target=bun-windows-x64", "--outfile", "dist/w.exe", "--with-cli"])).toEqual({
      target: "bun-windows-x64",
      outfile: "dist/w.exe",
      defines: [],
      variant: "bundled",
    });
  });
});
```

Update the existing three `toEqual` expectations to include `variant: "slim"`.

- [ ] **Step 2: Run to confirm failure**

Run: `bun test scripts/build-runner.test.ts`
Expected: FAIL — `variant` is undefined and `--with-cli` throws "unknown build:runner flag".

- [ ] **Step 3: Implement in `scripts/build-runner.ts`**

```ts
export type BuildArgs = {
  target: string;
  outfile: string;
  defines: string[];
  variant: "slim" | "bundled";
};
```

In `parseArgs`: initialise `variant: "slim"`; add `"--with-cli"` to `known`; handle it before the value logic:

```ts
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token === "--with-cli") {
      args.variant = "bundled";
      continue;
    }
    const flag = known.find((f) => token === f || token.startsWith(`${f}=`));
    ...
```

In `main`, pass the variant: `await generateShim(args.target, args.variant);` and update the header comment's usage block to:

```
 *   bun run build:runner                                # slim, host target
 *   bun run build:runner --with-cli                     # bundled CLI
 *   bun run build:runner --with-cli --target bun-windows-x64 \
 *     --outfile dist/cc-web-runner-bundled-windows-x64.exe \
 *     --define 'CC_WEB_DEFAULT_SERVER:"https://cc.example.com"'
```

- [ ] **Step 4: Run the tests**

Run: `bun test scripts/build-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-runner.ts scripts/build-runner.test.ts \
  packages/agent-adapter/src/claude-cli-version.ts \
  packages/agent-adapter/src/claude-cli-version.test.ts
git commit -m "feat(build): make the slim runner the default, add --with-cli, pin the CLI floor"
```

---

### Task 3: The host CLI resolver

**Files:**
- Create: `apps/runner/src/execution/claude-cli.ts`
- Create: `apps/runner/src/execution/claude-cli.test.ts`

**Interfaces:**
- Consumes: `MIN_CLAUDE_CLI_VERSION` from `@cc-web/agent-adapter`.
- Produces:
  - `export type ClaudeCliResolution = { ok: true; mode: "embedded" | "external"; path: string; version?: string } | { ok: false; reason: "missing" | "override-invalid" | "too-old"; guidance: string }`
  - `export type ClaudeCliInput = { kind: "embedded" | "external"; embeddedPath?: string; env: Record<string, string | undefined>; home: string; platform: string; which: (name: string) => string | undefined; exists: (path: string) => boolean; versionOf: (path: string) => string | undefined }`
  - `export function resolveClaudeCli(input: ClaudeCliInput): ClaudeCliResolution`
  - `export function parseCliVersion(stdout: string): string | undefined`
  - `export function compareVersions(a: string, b: string): number`
  - `export function installGuidance(minimum: string, reason: "missing" | "override-invalid" | "too-old"): string`
  - `export function hostClaudeCli(env?: Record<string, string | undefined>): ClaudeCliResolution` — production wiring (`Bun.which`, `existsSync`, `spawnSync` with a 5 s timeout).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import {
  compareVersions,
  installGuidance,
  parseCliVersion,
  resolveClaudeCli,
  type ClaudeCliInput,
} from "./claude-cli.ts";

const MIN = "2.1.309";

function input(overrides: Partial<ClaudeCliInput> = {}): ClaudeCliInput {
  return {
    kind: "external",
    env: {},
    home: "/home/op",
    platform: "linux",
    which: () => undefined,
    exists: () => false,
    versionOf: () => "2.1.400 (Claude Code)",
    ...overrides,
  };
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
      input({ kind: "embedded", embeddedPath: "/tmp/claude-extracted", which: () => { throw new Error("must not probe"); } }),
    );
    expect(result).toEqual({ ok: true, mode: "embedded", path: "/tmp/claude-extracted" });
  });

  test("an explicit CC_WEB_CLAUDE_BIN wins over PATH", () => {
    const result = resolveClaudeCli(
      input({ env: { CC_WEB_CLAUDE_BIN: "/opt/claude/bin/claude" }, exists: (p) => p === "/opt/claude/bin/claude", which: () => "/usr/bin/claude" }),
    );
    expect(result).toMatchObject({ ok: true, mode: "external", path: "/opt/claude/bin/claude", version: "2.1.400" });
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

  test("PATH answers when no override is set", () => {
    const result = resolveClaudeCli(input({ which: () => "/usr/local/bin/claude" }));
    expect(result).toMatchObject({ ok: true, path: "/usr/local/bin/claude" });
  });

  test("finds the native installer's binary when PATH lacks it", () => {
    // systemd starts services with PATH=/usr/bin:/bin; the native installer
    // puts the launcher in ~/.local/bin.
    const result = resolveClaudeCli(
      input({ exists: (p) => p === "/home/op/.local/bin/claude" }),
    );
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

  test("nothing found is a missing CLI with install guidance", () => {
    const result = resolveClaudeCli(input());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing");
    expect(result.guidance).toContain("https://claude.ai/install.sh");
  });

  test("a .cmd/.ps1 shim is refused as spawnable", () => {
    // The SDK spawns the path as a native binary; an npm shim is a batch file.
    const result = resolveClaudeCli(
      input({ platform: "win32", which: () => "C:\\Users\\op\\AppData\\Roaming\\npm\\claude.cmd" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("override-invalid");
    expect(result.guidance).toContain("claude.exe");
  });

  test("an older CLI is refused with upgrade guidance", () => {
    const result = resolveClaudeCli(
      input({ which: () => "/usr/bin/claude", versionOf: () => "2.1.100 (Claude Code)" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-old");
    expect(result.guidance).toContain("claude update");
    expect(result.guidance).toContain(MIN);
  });

  test("a hung or failed version probe is a failure, not a hang", () => {
    const result = resolveClaudeCli(
      input({ which: () => "/usr/bin/claude", versionOf: () => undefined }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-old");
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
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test apps/runner/src/execution/claude-cli.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/runner/src/execution/claude-cli.ts`**

Signature and rules, with the values the tests pin:

```ts
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MIN_CLAUDE_CLI_VERSION } from "@cc-web/agent-adapter";

export type ClaudeCliResolution =
  | { ok: true; mode: "embedded" | "external"; path: string; version?: string }
  | { ok: false; reason: "missing" | "override-invalid" | "too-old"; guidance: string };
```

- `parseCliVersion(stdout)`: first `/^(\d+\.\d+\.\d+)/m` match, else `undefined`.
- `compareVersions(a, b)`: split on `.`, numeric compare per segment.
- `installGuidance(minimum, reason)`: one builder; the missing variant prints the three install commands + `CC_WEB_CLAUDE_BIN` + minimum; `override-invalid` says the override path was not a usable `claude` (mention `.cmd`/`.ps1` and `claude.exe`); `too-old` says run `claude update` and states the minimum.
- Candidate list for `external`, in order:
  1. `env["CC_WEB_CLAUDE_BIN"]` — if present and not usable (`exists` false or shim-suffixed), return `override-invalid`.
  2. `which("claude")` — reject when the result ends in `.cmd`/`.ps1`/`.bat` (`override-invalid`, since it is found but not spawnable).
  3. Platform fallbacks (each accepted only when `exists` says yes):
     - `win32`: `join(home, ".local", "bin", "claude.exe")`, `join(env["LOCALAPPDATA"] ?? join(home, "AppData", "Local"), "Programs", "claude", "claude.exe")`
     - else: `join(home, ".local", "bin", "claude")`, `join(home, ".claude", "local", "claude")`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/bin/claude`
- Once a path is chosen: `version = versionOf(path)`; if `version === undefined` → `too-old` (message says the CLI could not report a version, run `claude update` or reinstall); if `compareVersions(version, MIN_CLAUDE_CLI_VERSION) < 0` → `too-old`.
- `embedded` kind: return `{ ok: true, mode: "embedded", path: input.embeddedPath! }` without touching `which`/`exists`/`versionOf`.

- `hostClaudeCli(env = process.env)` supplies the real deps:
  `which: (name) => Bun.which(name)`, `exists: existsSync`, `versionOf: (path) => { const r = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 5000 }); return r.status === 0 ? parseCliVersion(r.stdout ?? "") : undefined }`, `home: env["HOME"] ?? env["USERPROFILE"] ?? homedir()`, `kind: claudeCliKind()`, and `embeddedPath: embeddedCliPath()`.

- [ ] **Step 4: Run the tests**

Run: `bun test apps/runner/src/execution/claude-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/runner/src/execution/claude-cli.ts apps/runner/src/execution/claude-cli.test.ts
git commit -m "feat(runner): resolve and gate the host Claude Code CLI"
```

---

### Task 4: Refuse `setup` / `connect` / `service install` without a usable CLI

**Files:**
- Modify: `apps/runner/src/setup/setup.ts:74-112`
- Modify: `apps/runner/src/bootstrap/main.ts` (`USAGE`, `case "setup"`, `case "connect"`, `case "service"`, `--version`, `start()`)
- Modify: `apps/runner/src/index.ts` (`runnerInfo`)
- Test: `apps/runner/src/setup/setup.test.ts`

**Interfaces:**
- Consumes: `resolveClaudeCli`, `hostClaudeCli`, `installGuidance`, `ClaudeCliResolution` from Task 3.
- Produces: `SetupInput.skipCliCheck?: boolean`; `SetupDeps.resolveCli?: () => ClaudeCliResolution`.
- Produces: `runnerInfo = { name, protocolVersion, cliMode: "embedded" | "external" }`.

- [ ] **Step 1: Write the failing tests in `apps/runner/src/setup/setup.test.ts`**

Append:

```ts
describe("the Claude Code CLI gate", () => {
  const base = {
    serverUrl: "http://localhost:8787",
    runnerId: "r1",
    token: "t0ken",
    identityDir: "/tmp/identity",
  };

  test("refuses before writing anything when the CLI is missing", async () => {
    let saved = 0;
    const result = await runSetup(
      { ...base },
      {
        saveIdentity: () => {
          saved += 1;
        },
        resolveCli: () => ({ ok: false, reason: "missing", guidance: "install claude first" }),
      },
    );
    expect(result).toEqual({ ok: false, message: "install claude first" });
    expect(saved).toBe(0);
  });

  test("--skip-cli-check writes the identity anyway", async () => {
    let saved = 0;
    const result = await runSetup(
      { ...base, skipCliCheck: true },
      {
        saveIdentity: () => {
          saved += 1;
        },
        resolveCli: () => ({ ok: false, reason: "missing", guidance: "install claude first" }),
      },
    );
    expect(result).toMatchObject({ ok: true, controlUrl: "ws://localhost:8787/ws/runner" });
    expect(saved).toBe(1);
  });

  test("a usable CLI changes nothing", async () => {
    let saved = 0;
    const result = await runSetup(
      { ...base },
      {
        saveIdentity: () => {
          saved += 1;
        },
        resolveCli: () => ({ ok: true, mode: "external", path: "/usr/bin/claude", version: "2.1.400" }),
      },
    );
    expect(result.ok).toBe(true);
    expect(saved).toBe(1);
  });

  test("no resolver injected means no check (bundled builds, older callers)", async () => {
    let saved = 0;
    const result = await runSetup({ ...base }, { saveIdentity: () => { saved += 1; } });
    expect(result.ok).toBe(true);
    expect(saved).toBe(1);
  });

  test("the token is still checked before the CLI gate", async () => {
    // Precedence: an operator who also forgot the token must hear about the
    // token, not be sent to install a CLI for a setup that could not work.
    const result = await runSetup(
      { ...base, token: undefined },
      {
        saveIdentity: () => {},
        resolveCli: () => ({ ok: false, reason: "missing", guidance: "install claude first" }),
      },
    );
    expect(result).toEqual({ ok: false, message: "setup: no token arrived (env CC_WEB_RUNNER_TOKEN, TTY or stdin)" });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bun test apps/runner/src/setup/setup.test.ts`
Expected: FAIL — unknown properties `skipCliCheck` / `resolveCli`.

- [ ] **Step 3: Implement the gate in `packages/agent-adapter`→`apps/runner/src/setup/setup.ts`**

Add fields and check **after** the token check, **before** `saveIdentity`:

```ts
export type SetupInput = {
  serverUrl: string;
  runnerId: string;
  token: string | undefined;
  identityDir: string;
  /** `--skip-cli-check`: write the identity even when the host CLI is unusable. */
  skipCliCheck?: boolean;
};

export type SetupDeps = {
  saveIdentity: (dir: string, identity: RunnerIdentity) => Promise<void> | void;
  /**
   * Resolves this runner's Claude Code CLI. Absent means "do not check": a
   * bundled build needs no host CLI, and callers outside the connector keep
   * working unchanged.
   */
  resolveCli?: () => ClaudeCliResolution;
};
```

```ts
  if (deps.resolveCli !== undefined && input.skipCliCheck !== true) {
    const cli = deps.resolveCli();
    if (!cli.ok) return { ok: false, message: cli.guidance };
  }
```

- [ ] **Step 4: Wire the resolver into `apps/runner/src/bootstrap/main.ts`**

Add near the other imports:

```ts
import { claudeCliKind } from "@cc-web/agent-adapter";
import { hostClaudeCli, type ClaudeCliResolution } from "../execution/claude-cli.ts";
```

Add a helper after `parseOptions`:

```ts
/** `--skip-cli-check`, or CC_WEB_SKIP_CLI_CHECK=1, bypasses the host-CLI gate. */
function skipsCliCheck(options: Record<string, string>): boolean {
  return options["skip-cli-check"] === "true" || process.env["CC_WEB_SKIP_CLI_CHECK"] === "1";
}

/**
 * One resolution per process: connect, service install and setup all use it,
 * and the resolved path is what the probes and the executor receive.
 */
function requireClaudeCli(options: Record<string, string>): ClaudeCliResolution | undefined {
  const cli = hostClaudeCli();
  if (cli.ok) return cli;
  if (skipsCliCheck(options)) {
    process.stderr.write(`warning: ${cli.guidance}\n`);
    return undefined;
  }
  process.stderr.write(`${cli.guidance}\n`);
  process.exit(1);
  return undefined;
}
```

`case "setup"`: pass `skipCliCheck: skipsCliCheck(options)` in `SetupInput`, and inject the check:

```ts
      {
        saveIdentity,
        // A bundled build carries its own CLI; only slim builds depend on the host.
        ...(claudeCliKind() === "external"
          ? { resolveCli: () => hostClaudeCli() }
          : {}),
      },
```

`case "connect"` / `"run"`: before `start(options)`:

```ts
    if (options["home"]) process.env["CC_WEB_RUNNER_HOME"] = options["home"];
    const cli = requireClaudeCli(options);
    await start(options, cli?.path);
```

`case "service"`: for `sub === "install"` only, before any file is written:

```ts
    if (sub === "install") requireClaudeCli(options);
```

Place it after `const options = parseOptions(...)` / `scope` / `home` are computed but before the `process.platform === "win32"` branch, so `service print` and `service uninstall` never check.

`start()`: change the signature to `async function start(options?: Record<string, string>, claudeCliPath?: string)` and pass `...(claudeCliPath === undefined ? {} : { claudeCliPath })` to `discoverModels`, `discoverCapabilities` and `startDaemon` (those parameters arrive in Task 5).

`--version`: extend the output using `runnerInfo.cliMode`:

```ts
    console.log(`${runnerInfo.name} (protocol v${runnerInfo.protocolVersion}, cli ${runnerInfo.cliMode})`);
```

Also add `[--skip-cli-check]` to the `USAGE` lines for `setup`, `connect` and `service install`.

`apps/runner/src/index.ts`:

```ts
import { claudeCliKind } from "@cc-web/agent-adapter";

export const runnerInfo = {
  name: "cc-web-runner",
  protocolVersion: PROTOCOL_VERSION,
  cliMode: claudeCliKind(),
} as const;
```

Watch for an import cycle: `index.ts` importing the adapter is fine (the adapter does not import the runner).

- [ ] **Step 5: Run the tests**

Run: `bun test apps/runner/src/setup/setup.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/runner/src/setup/setup.ts apps/runner/src/setup/setup.test.ts \
  apps/runner/src/bootstrap/main.ts apps/runner/src/index.ts
git commit -m "feat(runner): refuse setup and service install without a usable Claude Code"
```

---

### Task 5: Thread the resolved path through the probes and the adapter

**Files:**
- Modify: `apps/runner/src/execution/model-catalog.ts:24,67`
- Modify: `apps/runner/src/execution/capability-catalog.ts:24,100`
- Modify: `apps/runner/src/daemon.ts` (`DaemonOptions`, `RunController` construction)
- Test: `apps/runner/src/execution/model-catalog.test.ts`
- Test: `apps/runner/src/execution/capability-catalog.test.ts`

**Interfaces:**
- Consumes: `claudeCliKind`/`embeddedCliPath` from Task 1; `claudeCliPath?: string` from `main.ts` (Task 4).
- Produces: `DiscoverModelsOptions.claudeCliPath?: string`; `DiscoverCapabilitiesOptions.claudeCliPath?: string`; `DaemonOptions.claudeCliPath?: string`.

- [ ] **Step 1: Write the failing tests**

In `model-catalog.test.ts` inside the existing options-mapping describe:

```ts
  test("passes an explicit CLI path to the SDK probe", async () => {
    const p = probe();
    await discoverModels({ cwd: "/w", load: p.load, claudeCliPath: "/opt/claude/claude" });
    expect(p.params[0]?.options["pathToClaudeCodeExecutable"]).toBe("/opt/claude/claude");
  });

  test("omits the CLI path when the build embeds one", async () => {
    const p = probe();
    await discoverModels({ cwd: "/w", load: p.load });
    expect("pathToClaudeCodeExecutable" in (p.params[0]?.options ?? {})).toBe(
      embeddedCliPath() !== undefined,
    );
  });
```

(The second test's assertion is: with a bundled shim the adapter default applies, so the probe still sets it; with a slim shim and no explicit path the option is absent. Write it as the equality above so it holds in both shim states.)

Apply the analogous two tests in `capability-catalog.test.ts`.

- [ ] **Step 2: Run to confirm failure**

Run: `bun test apps/runner/src/execution/model-catalog.test.ts apps/runner/src/execution/capability-catalog.test.ts`
Expected: FAIL — `claudeCliPath` is not a known option and the option is always set from `claudeCliPath()`.

- [ ] **Step 3: Implement**

In both catalogs: add `claudeCliPath?: string` to the options type with the comment "the resolved host CLI for a slim build; absent means the build's own embedded asset", replace the import of `claudeCliPath` with `embeddedCliPath`, and change the probe options to:

```ts
        ...(options.claudeCliPath === undefined && embeddedCliPath() === undefined
          ? {}
          : { pathToClaudeCodeExecutable: options.claudeCliPath ?? embeddedCliPath() }),
```

In `apps/runner/src/daemon.ts`: add to `DaemonOptions`:

```ts
  /**
   * The resolved host CLI path (§20.3). A slim build has no embedded CLI, so
   * every SDK call must name this one; absent leaves the adapter's default.
   */
  claudeCliPath?: string;
```

and thread it into the `RunController` seams:

```ts
    sdk:
      options.sdk ??
      ((input) =>
        createSdkStream({
          ...input,
          ...(options.claudeCliPath === undefined
            ? {}
            : { pathToClaudeCodeExecutable: options.claudeCliPath }),
        })),
```

- [ ] **Step 4: Run the tests**

Run: `bun test apps/runner/src/execution apps/runner/src/daemon.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the whole tree**

Run: `bun run typecheck`
Expected: PASS. This is the first point where every `claudeCliPath` caller is gone and the union shim typechecks.

- [ ] **Step 6: Commit**

```bash
git add apps/runner/src/execution/model-catalog.ts apps/runner/src/execution/model-catalog.test.ts \
  apps/runner/src/execution/capability-catalog.ts apps/runner/src/execution/capability-catalog.test.ts \
  apps/runner/src/daemon.ts
git commit -m "feat(runner): pass the resolved host CLI to every SDK entry point"
```

---

### Task 6: Integration probes and the release matrix

**Files:**
- Modify: `scripts/integration/runner-agent-e2e.ts:164-172`
- Modify: `scripts/integration/runner-binary.ts:88-115`
- Modify: `.github/workflows/runner-build.yml:36-60,88-105`

**Interfaces:**
- Consumes: `--with-cli` (Task 2), `--skip-cli-check` (Task 4).

- [ ] **Step 1: Make the agent probe explicit about the bundled build**

In `scripts/integration/runner-agent-e2e.ts`, change the build invocation and the comment above it:

```ts
  // --- 1. build the binary through build:runner (the asset-shim path) ---
  // This probe exists to prove the EMBEDDED path: the SDK cannot resolve its
  // own CLI inside $bunfs, so the asset is extracted at first use. A slim build
  // has no asset to extract, hence --with-cli.
  console.log("building dist/cc-web-runner (bun run build:runner --with-cli)…");
  const build = Bun.spawnSync(["bun", "run", "build:runner", "--with-cli", "--outfile", binary], {
```

- [ ] **Step 2: Make the binary probe test the slim default**

In `scripts/integration/runner-binary.ts`, the existing `setup` (line ~90) gains `--skip-cli-check`, and a new assertion follows it:

```ts
    const setup = Bun.spawnSync(
      [
        binary,
        "setup",
        "--server",
        "http://localhost:8787",
        "--runner-id",
        runnerId,
        // The default build is slim: this CI host has no Claude Code.
        "--skip-cli-check",
      ],
      { ... },
    );
```

Then, before closing the `try`:

```ts
    // Slim default + no CLI anywhere on PATH: setup must refuse and leave no
    // identity behind — half a configuration fails later and more confusingly.
    const refusedHome = await mkdtemp(join(tmpdir(), "cc-web-refused-"));
    try {
      const refused = Bun.spawnSync(
        [binary, "setup", "--server", "http://localhost:8787", "--runner-id", "no-cli"],
        {
          env: {
            ...process.env,
            PATH: "",
            CC_WEB_RUNNER_HOME: refusedHome,
            CC_WEB_RUNNER_TOKEN: "x",
            CC_WEB_CLAUDE_BIN: "",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stderr = new TextDecoder().decode(refused.stderr);
      check(
        "slim setup without a host CLI refuses and writes nothing",
        refused.exitCode === 1 &&
          stderr.includes("https://claude.ai/install.sh") &&
          !existsSync(join(refusedHome, "identity.json")),
        `exit=${refused.exitCode}`,
      );
    } finally {
      await rm(refusedHome, { recursive: true, force: true });
    }
```

Add `existsSync` to the `node:fs` import if absent.

- [ ] **Step 3: Run both probes**

Run: `bun run scripts/integration/runner-binary.ts && bun run scripts/integration/runner-agent-e2e.ts`
Expected: every `check(...)` prints PASS. (The agent probe still needs host credentials for a `run.finished`; an auth-shaped failure is acceptable per its docstring, an asset-shaped one is not.)

- [ ] **Step 4: Add the variant matrix to the release workflow**

In `.github/workflows/runner-build.yml`, extend the matrix entries with `variant` and give the bundled rows their artifact names:

```yaml
        include:
          - target: bun-linux-x64
            binary: cc-web-runner-linux-x64
            variant: slim
          - target: bun-linux-arm64
            binary: cc-web-runner-linux-arm64
            variant: slim
          - target: bun-windows-x64
            binary: cc-web-runner-windows-x64.exe
            variant: slim
          - target: bun-windows-arm64
            binary: cc-web-runner-windows-arm64.exe
            variant: slim
          - target: bun-linux-x64
            binary: cc-web-runner-bundled-linux-x64
            variant: bundled
          - target: bun-linux-arm64
            binary: cc-web-runner-bundled-linux-arm64
            variant: bundled
          - target: bun-windows-x64
            binary: cc-web-runner-bundled-windows-x64.exe
            variant: bundled
          - target: bun-windows-arm64
            binary: cc-web-runner-bundled-windows-arm64.exe
            variant: bundled
```

Gate the asset step and pass the flag:

```yaml
      - name: Install the target platform's SDK CLI
        if: matrix.variant == 'bundled'
        run: bun run scripts/claude-target-asset.ts --target=${{ matrix.target }}
```

```yaml
          args=(--target="${{ matrix.target }}" --outfile "dist/${{ matrix.binary }}")
          if [ "${{ matrix.variant }}" = "bundled" ]; then
            args+=(--with-cli)
          fi
```

The `Smoke the linux-x64 binary` step keeps `if: matrix.target == 'bun-linux-x64'`; add `&& matrix.variant == 'slim'` so it smokes the artifact most operators download.

- [ ] **Step 5: Commit**

```bash
git add scripts/integration/runner-binary.ts scripts/integration/runner-agent-e2e.ts \
  .github/workflows/runner-build.yml
git commit -m "test(ci): cover the slim default and build both runner variants"
```

---

### Task 7: Docs and ADR

**Files:**
- Modify: `docs/ARCHITECTURE.md:345-357` (§7.1), `docs/ARCHITECTURE.md:1141` (§20.3), ADR table (§ near line 1360)
- Modify: `docs/DEPLOYMENT.md:215-250`
- Create: `docs/adr/0017-runner-cli-variants.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Revise §7.1**

Replace the sentence "Mỗi Runner dùng bundled Claude Code của SDK…" with the two-mode decision: slim (default) uses the host's `claude`, resolved from `CC_WEB_CLAUDE_BIN` → `PATH` → well-known install dirs, gated at `MIN_CLAUDE_CLI_VERSION`; bundled embeds the SDK's platform binary via the generated shim. Keep the "configuration inheritance is independent of which binary runs" point and update the `pathToClaudeCodeExecutable` paragraph to say it is always set by the runner's resolver (or by the adapter from the embedded asset).

- [ ] **Step 2: Revise §20.3**

Add to the paragraph at line 1141: default build is slim; `--with-cli` embeds the CLI; the ~280 MB size is now opt-in; slim refuses `setup`/`connect`/`service install` without a host CLI (`--skip-cli-check` bypasses); `claude update` guidance on an old CLI; the release matrix now publishes eight artifacts.

- [ ] **Step 3: Add the ADR**

`docs/adr/0017-runner-cli-variants.md` — follow the format of 0001/0002: status accepted (2026-11-12), context (286–293 MB per download for hosts that already have Claude Code), decision (two build variants, slim default, runtime resolution order, version floor tied to the SDK manifest, hard refusal with `--skip-cli-check` escape hatch), consequences (a slim host must manage its own CLI updates; the release pipeline publishes both variants; CI proves both paths).

Add a row to the ADR table in `docs/ARCHITECTURE.md`:

```
| ADR-017 | Runner build variants: slim (default) uses the host's Claude Code; `--with-cli` embeds the SDK CLI (2026-11-12) | Không tải 293 MB cho host đã có CLI; host tự quản lý version |
```

- [ ] **Step 4: Update `docs/DEPLOYMENT.md`**

In the runner build section, show both commands and the artifact names; add a short paragraph: a slim runner needs `claude` on the host (`curl -fsSL https://claude.ai/install.sh | bash`, then log in once), or `CC_WEB_CLAUDE_BIN` in `/etc/cc-web-runner.env`; systemd's `PATH` does not include `~/.local/bin`, which the resolver's fallback list covers.

- [ ] **Step 5: Verify the docs render and commit**

Run: `git diff --stat docs/`
Expected: four files changed, no code files.

```bash
git add docs/ARCHITECTURE.md docs/DEPLOYMENT.md docs/adr/0017-runner-cli-variants.md \
  docs/superpowers/specs/2026-11-10-runner-cli-variant-design.md
git commit -m "docs: document slim and bundled runner builds"
```

---

## Self-Review

- **Spec coverage:** §6.1 → Task 1; §6.2 → Task 3; §6.3 → Tasks 2+3; §6.4 → Tasks 4+5; §6.5 → Task 3 (`installGuidance`); §6.6 → Tasks 2+6; §6.7 → Task 4; §7 inventory → Tasks 1–7; §8 risks → Review Focus items 1–5 plus Task 2's drift test.
- **Type consistency:** `ClaudeCliResolution` is defined once (Task 3) and imported by Tasks 4–5; `claudeCliPath` is the single field name in `DiscoverModelsOptions`, `DiscoverCapabilitiesOptions` and `DaemonOptions`; `claudeCliKind`/`embeddedCliPath` are the only names replacing the removed `claudeCliPath()` helper.
- **Proportion:** seven tasks, each with one deliverable; code blocks are limited to signatures, shim text and test bodies the spec pins.
